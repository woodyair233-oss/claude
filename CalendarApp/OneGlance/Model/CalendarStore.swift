import EventKit
import SwiftUI
import WidgetKit
import GlanceCore

/// Reads and writes the system calendar database through EventKit. There is
/// no copy to keep in sync: the system Calendar and Reminders apps, iCloud and
/// other accounts all see the same data, and `EKEventStoreChanged` tells us
/// whenever anything (including another device) changes it.
@MainActor
final class CalendarStore: ObservableObject {
    let ek = EKEventStore()
    let prefs: Preferences

    @Published private(set) var eventAccess: EKAuthorizationStatus
    @Published private(set) var reminderAccess: EKAuthorizationStatus
    @Published private(set) var eventCalendars: [EKCalendar] = []
    @Published private(set) var reminderLists: [EKCalendar] = []
    @Published private(set) var events: [EventItem] = []
    @Published private(set) var tasks: [TaskItem] = []
    @Published var toast: Toast?

    struct Toast: Identifiable {
        let id = UUID()
        var message: String
        var undo: (@MainActor () -> Void)?
    }

    private var ekEvents: [String: EKEvent] = [:]
    private var ekReminders: [String: EKReminder] = [:]
    private var agendaCache: [Date: DayAgenda] = [:]
    private(set) var loadedRange: DateInterval
    private var observer: NSObjectProtocol?
    private var reloadTask: Task<Void, Never>?
    private var reminderGeneration = 0
    private var taskDurations: [String: Int]

    init(prefs: Preferences) {
        self.prefs = prefs
        eventAccess = EKEventStore.authorizationStatus(for: .event)
        reminderAccess = EKEventStore.authorizationStatus(for: .reminder)
        loadedRange = Self.range(around: Date())
        taskDurations = UserDefaults.standard.dictionary(forKey: "taskDurations") as? [String: Int] ?? [:]
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: ek, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.scheduleReload() }
        }
        reload()
    }

    // MARK: - Access

    var hasEventAccess: Bool { eventAccess == .fullAccess }
    var hasReminderAccess: Bool { reminderAccess == .fullAccess }
    var needsPermission: Bool { !hasEventAccess }

    func requestAccess() async {
        _ = try? await ek.requestFullAccessToEvents()
        _ = try? await ek.requestFullAccessToReminders()
        reload()
    }

    // MARK: - Loading

    /// Six-week month grid around `date`, plus a week of margin on each side.
    static func range(around date: Date) -> DateInterval {
        let cal = Calendar.current
        let grid = cal.monthGrid(for: date)
        let start = cal.date(byAdding: .day, value: -7, to: grid.first ?? date) ?? date
        let end = cal.date(byAdding: .day, value: 8, to: grid.last ?? date) ?? date
        return DateInterval(start: start, end: end)
    }

    /// Reloads when the user moves to a month outside the loaded window.
    func ensureLoaded(around date: Date) {
        let needed = Self.range(around: date)
        if needed.start < loadedRange.start || needed.end > loadedRange.end {
            loadedRange = needed
            reload()
        }
    }

    /// Coalesces bursts of change notifications (our own saves trigger them too).
    func scheduleReload() {
        reloadTask?.cancel()
        reloadTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            self?.reload()
        }
    }

    func refreshFromSystem() {
        ek.refreshSourcesIfNecessary()
        reload()
    }

    func reload() {
        eventAccess = EKEventStore.authorizationStatus(for: .event)
        reminderAccess = EKEventStore.authorizationStatus(for: .reminder)

        if hasEventAccess {
            eventCalendars = ek.calendars(for: .event).sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
            let visible = eventCalendars.filter { !prefs.hiddenCalendarIDs.contains($0.calendarIdentifier) }
            var map: [String: EKEvent] = [:]
            var items: [EventItem] = []
            if !visible.isEmpty {
                let predicate = ek.predicateForEvents(withStart: loadedRange.start, end: loadedRange.end, calendars: visible)
                for ev in ek.events(matching: predicate) {
                    let item = makeItem(ev)
                    map[item.id] = ev
                    items.append(item)
                }
            }
            ekEvents = map
            events = items.sorted { ($0.start, $0.end) < ($1.start, $1.end) }
        } else {
            eventCalendars = []
            ekEvents = [:]
            events = []
        }
        agendaCache = [:]

        if hasReminderAccess {
            reminderLists = ek.calendars(for: .reminder).sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
            let visible = reminderLists.filter { !prefs.hiddenCalendarIDs.contains($0.calendarIdentifier) }
            reminderGeneration += 1
            let generation = reminderGeneration
            if visible.isEmpty {
                applyReminders([])
            } else {
                let incomplete = ek.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: visible)
                let completed = ek.predicateForCompletedReminders(withCompletionDateStarting: loadedRange.start,
                                                                  ending: loadedRange.end, calendars: visible)
                Task { [weak self] in
                    guard let self else { return }
                    let open = await self.fetch(incomplete)
                    let done = await self.fetch(completed)
                    guard generation == self.reminderGeneration else { return }
                    self.applyReminders(open + done)
                }
            }
        } else {
            reminderLists = []
            applyReminders([])
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    private func fetch(_ predicate: NSPredicate) async -> [EKReminder] {
        await withCheckedContinuation { continuation in
            ek.fetchReminders(matching: predicate) { continuation.resume(returning: $0 ?? []) }
        }
    }

    private func applyReminders(_ reminders: [EKReminder]) {
        var map: [String: EKReminder] = [:]
        for r in reminders { map[r.calendarItemIdentifier] = r }
        ekReminders = map
        tasks = map.values.map { makeItem($0) }.sorted { a, b in
            switch (a.due, b.due) {
            case let (x?, y?): return x < y
            case (nil, _?): return false
            case (_?, nil): return true
            default: return a.title < b.title
            }
        }
        agendaCache = [:]
    }

    private func makeItem(_ ev: EKEvent) -> EventItem {
        let title = ev.title ?? ""
        let shift = prefs.template(id: ShiftMarker.templateID(from: ev.url))
            ?? prefs.shiftTemplates.first { $0.name == title }
        return EventItem(
            id: "\(ev.eventIdentifier ?? ev.calendarItemIdentifier)|\(Int(ev.startDate.timeIntervalSince1970))",
            eventID: ev.eventIdentifier ?? ev.calendarItemIdentifier,
            title: title.isEmpty ? "（无标题）" : title,
            start: ev.startDate,
            end: ev.endDate,
            isAllDay: ev.isAllDay,
            calendarID: ev.calendar.calendarIdentifier,
            calendarTitle: ev.calendar.title,
            color: Color(cgColor: ev.calendar.cgColor),
            location: ev.location,
            notes: ev.notes,
            isRecurring: ev.hasRecurrenceRules || ev.isDetached,
            canEdit: ev.calendar.allowsContentModifications,
            shift: shift)
    }

    private func makeItem(_ r: EKReminder) -> TaskItem {
        let cal = Calendar.current
        var due: Date?
        var hasTime = false
        if let comps = r.dueDateComponents, let date = cal.date(from: comps) {
            hasTime = comps.hour != nil
            due = hasTime ? date : cal.startOfDay(for: date)
        }
        let id = r.calendarItemIdentifier
        return TaskItem(
            id: id,
            title: (r.title ?? "").isEmpty ? "（无标题）" : r.title,
            notes: r.notes,
            due: due,
            hasTime: hasTime,
            isCompleted: r.isCompleted,
            completionDate: r.completionDate,
            priority: r.priority,
            listID: r.calendar.calendarIdentifier,
            listTitle: r.calendar.title,
            color: Color(cgColor: r.calendar.cgColor),
            durationMinutes: taskDurations[id] ?? prefs.defaultTaskMinutes)
    }

    // MARK: - Queries

    func agenda(for day: Date) -> DayAgenda {
        let cal = Calendar.current
        let start = cal.startOfDay(for: day)
        if let cached = agendaCache[start] { return cached }
        let end = cal.date(byAdding: .day, value: 1, to: start) ?? start
        let isToday = cal.isDateInToday(start)
        var a = DayAgenda(day: start)

        for e in events where e.start < end && (e.end > start || (e.end == e.start && e.start >= start)) {
            if let shift = e.shift {
                if cal.isDate(e.start, inSameDayAs: start) { a.shifts.append(e) }
                if !shift.isAllDay && !e.isAllDay { a.timed.append(e) }
            } else if e.isAllDay {
                a.allDay.append(e)
            } else {
                a.timed.append(e)
            }
        }
        for t in tasks {
            if t.isCompleted {
                let doneDay = t.completionDate ?? t.due
                if let d = doneDay, cal.isDate(d, inSameDayAs: start) { a.completed.append(t) }
            } else if let due = t.due {
                if cal.isDate(due, inSameDayAs: start) {
                    if t.hasTime { a.timedTasks.append(t) } else { a.untimedTasks.append(t) }
                } else if isToday, due < start {
                    a.overdue.append(t)
                }
            }
        }
        a.untimedTasks.sort { ($0.priority == 0 ? 10 : $0.priority, $0.title) < ($1.priority == 0 ? 10 : $1.priority, $1.title) }
        agendaCache[start] = a
        return a
    }

    /// Open reminders without a due date: the pool to plan from.
    var inbox: [TaskItem] { tasks.filter { !$0.isCompleted && $0.due == nil } }

    /// 0…4 for the heat map: timed events and tasks (overlaps counted once),
    /// plus 15 minutes for every open task without a time.
    func loadLevel(for day: Date) -> Int {
        let a = agenda(for: day)
        let cal = Calendar.current
        var intervals: [(start: Double, end: Double)] = a.timed.map {
            (start: cal.minuteOfDay($0.start, relativeTo: day), end: cal.minuteOfDay($0.end, relativeTo: day))
        }
        for t in a.timedTasks {
            guard let due = t.due else { continue }
            let s = cal.minuteOfDay(due, relativeTo: day)
            intervals.append((start: s, end: s + Double(t.durationMinutes)))
        }
        let busy = DayLoad.busyMinutes(intervals) + Double(a.untimedTasks.count) * 15
        return DayLoad.level(busyMinutes: busy, capacityMinutes: prefs.dayCapacityHours * 60)
    }

    /// Hours of rest before the shift that starts on `day`, if it is shorter than the user's minimum.
    func shortRest(before shift: EventItem) -> Double? {
        guard let template = shift.shift, !template.isAllDay else { return nil }
        let previous = events
            .filter { $0.shift != nil && !($0.shift?.isAllDay ?? true) && !$0.isAllDay && $0.start < shift.start && $0.id != shift.id }
            .max { $0.end < $1.end }
        guard let previous else { return nil }
        let hours = shift.start.timeIntervalSince(previous.end) / 3600
        return hours < prefs.minimumRestHours ? max(hours, 0) : nil
    }

    func shiftOccurrences(in interval: DateInterval) -> [ShiftAnalysis.Occurrence] {
        events.filter { $0.shift != nil && $0.start >= interval.start && $0.start < interval.end }
            .map { ShiftAnalysis.Occurrence(templateID: $0.shift?.id, start: $0.start, end: $0.end,
                                            isAllDay: $0.isAllDay || ($0.shift?.isAllDay ?? false)) }
    }

    var editableCalendars: [EKCalendar] { eventCalendars.filter(\.allowsContentModifications) }
    var editableLists: [EKCalendar] { reminderLists.filter(\.allowsContentModifications) }

    var defaultEventCalendar: EKCalendar? {
        prefs.defaultEventCalendarID.flatMap { ek.calendar(withIdentifier: $0) } ?? ek.defaultCalendarForNewEvents
    }

    var defaultReminderList: EKCalendar? {
        prefs.defaultReminderListID.flatMap { ek.calendar(withIdentifier: $0) } ?? ek.defaultCalendarForNewReminders()
    }

    var shiftCalendar: EKCalendar? {
        prefs.shiftCalendarID.flatMap { ek.calendar(withIdentifier: $0) } ?? defaultEventCalendar
    }

    func calendar(matching hint: String?, in calendars: [EKCalendar]) -> EKCalendar? {
        guard let hint = hint?.lowercased(), !hint.isEmpty else { return nil }
        return calendars.first { $0.title.lowercased() == hint }
            ?? calendars.first { $0.title.lowercased().hasPrefix(hint) }
            ?? calendars.first { $0.title.lowercased().contains(hint) }
    }

    // MARK: - Event changes

    func move(_ item: EventItem, toStart newStart: Date) {
        guard let ev = ekEvents[item.id], item.canEdit else { return }
        let length = ev.endDate.timeIntervalSince(ev.startDate)
        ev.startDate = newStart
        ev.endDate = newStart.addingTimeInterval(length)
        save(ev)
    }

    func resize(_ item: EventItem, toEnd newEnd: Date) {
        guard let ev = ekEvents[item.id], item.canEdit else { return }
        ev.endDate = max(newEnd, ev.startDate.addingTimeInterval(15 * 60))
        save(ev)
    }

    struct EventDraft {
        var existingID: String?
        var title = ""
        var start = Date()
        var end = Date().addingTimeInterval(3600)
        var isAllDay = false
        var calendarID: String?
        var location = ""
        var notes = ""
        var url: URL?
    }

    func draft(for item: EventItem) -> EventDraft {
        EventDraft(existingID: item.id, title: item.title, start: item.start, end: item.end,
                   isAllDay: item.isAllDay, calendarID: item.calendarID,
                   location: item.location ?? "", notes: item.notes ?? "")
    }

    @discardableResult
    func save(_ draft: EventDraft) -> String? {
        let ev: EKEvent
        if let id = draft.existingID {
            guard let existing = ekEvents[id] else { return nil }
            ev = existing
        } else {
            ev = EKEvent(eventStore: ek)
            ev.url = draft.url
        }
        ev.title = draft.title.isEmpty ? "新日程" : draft.title
        ev.isAllDay = draft.isAllDay
        if draft.isAllDay {
            let cal = Calendar.current
            ev.startDate = cal.startOfDay(for: draft.start)
            ev.endDate = max(cal.startOfDay(for: draft.end), ev.startDate)
        } else {
            ev.startDate = draft.start
            ev.endDate = max(draft.end, draft.start.addingTimeInterval(5 * 60))
        }
        ev.location = draft.location.isEmpty ? nil : draft.location
        ev.notes = draft.notes.isEmpty ? nil : draft.notes
        if let calID = draft.calendarID, let cal = ek.calendar(withIdentifier: calID) {
            ev.calendar = cal
        } else if ev.calendar == nil {
            ev.calendar = defaultEventCalendar
        }
        return save(ev) ? ev.eventIdentifier : nil
    }

    func delete(_ item: EventItem) {
        guard let ev = ekEvents[item.id] else { return }
        do {
            try ek.remove(ev, span: .thisEvent, commit: true)
        } catch {
            report(error)
        }
        reload()
    }

    @discardableResult
    private func save(_ ev: EKEvent) -> Bool {
        do {
            try ek.save(ev, span: .thisEvent, commit: true)
            reload()
            return true
        } catch {
            report(error)
            reload()
            return false
        }
    }

    // MARK: - Task changes

    func toggle(_ task: TaskItem) {
        guard let r = ekReminders[task.id] else { return }
        r.isCompleted.toggle()
        saveReminder(r)
    }

    /// Sets (or clears) the due date. A due time gets a matching alert, like in the Reminders app.
    func schedule(_ task: TaskItem, at date: Date?, hasTime: Bool) {
        guard let r = ekReminders[task.id] else { return }
        apply(due: date, hasTime: hasTime, to: r)
        saveReminder(r)
    }

    func postpone(_ task: TaskItem, days: Int = 1) {
        let cal = Calendar.current
        let base = max(task.due ?? cal.startOfDay(for: Date()), cal.startOfDay(for: Date()))
        let target = cal.date(byAdding: .day, value: days, to: base) ?? base
        schedule(task, at: task.hasTime ? target : cal.startOfDay(for: target), hasTime: task.hasTime)
    }

    func setDuration(_ task: TaskItem, minutes: Int) {
        taskDurations[task.id] = max(15, minutes)
        UserDefaults.standard.set(taskDurations, forKey: "taskDurations")
        applyReminders(Array(ekReminders.values))
    }

    struct TaskDraft {
        var existingID: String?
        var title = ""
        var notes = ""
        var hasDate = true
        var hasTime = false
        var due = Date()
        var durationMinutes = 30
        var priority = 0
        var listID: String?
        var isCompleted = false
    }

    func draft(for task: TaskItem) -> TaskDraft {
        TaskDraft(existingID: task.id, title: task.title, notes: task.notes ?? "",
                  hasDate: task.due != nil, hasTime: task.hasTime, due: task.due ?? Date(),
                  durationMinutes: task.durationMinutes, priority: task.priority,
                  listID: task.listID, isCompleted: task.isCompleted)
    }

    @discardableResult
    func save(_ draft: TaskDraft) -> String? {
        let r: EKReminder
        if let id = draft.existingID {
            guard let existing = ekReminders[id] else { return nil }
            r = existing
        } else {
            r = EKReminder(eventStore: ek)
        }
        r.title = draft.title.isEmpty ? "新待办" : draft.title
        r.notes = draft.notes.isEmpty ? nil : draft.notes
        r.priority = draft.priority
        if let listID = draft.listID, let list = ek.calendar(withIdentifier: listID) {
            r.calendar = list
        } else if r.calendar == nil {
            r.calendar = defaultReminderList
        }
        apply(due: draft.hasDate ? draft.due : nil, hasTime: draft.hasDate && draft.hasTime, to: r)
        if r.isCompleted != draft.isCompleted { r.isCompleted = draft.isCompleted }
        guard saveReminder(r) else { return nil }
        taskDurations[r.calendarItemIdentifier] = draft.durationMinutes
        UserDefaults.standard.set(taskDurations, forKey: "taskDurations")
        return r.calendarItemIdentifier
    }

    func delete(_ task: TaskItem) {
        guard let r = ekReminders[task.id] else { return }
        do {
            try ek.remove(r, commit: true)
        } catch {
            report(error)
        }
        reload()
    }

    private func apply(due date: Date?, hasTime: Bool, to r: EKReminder) {
        let cal = Calendar.current
        // Keep location and relative alerts; replace the absolute one tied to the old due time
        let kept = (r.alarms ?? []).filter { $0.absoluteDate == nil }
        guard let date else {
            r.dueDateComponents = nil
            r.alarms = kept
            return
        }
        if hasTime {
            r.dueDateComponents = cal.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            r.alarms = kept + [EKAlarm(absoluteDate: date)]
        } else {
            r.dueDateComponents = cal.dateComponents([.year, .month, .day], from: date)
            r.alarms = kept
        }
    }

    @discardableResult
    private func saveReminder(_ r: EKReminder) -> Bool {
        do {
            try ek.save(r, commit: true)
            reload()
            return true
        } catch {
            report(error)
            reload()
            return false
        }
    }

    // MARK: - Shifts

    /// Brush behaviour: the same shift again removes it, a different one replaces it.
    func applyShift(_ template: ShiftTemplate, on day: Date) {
        let existing = agenda(for: day).shifts
        let sameAlready = existing.contains { $0.shift?.id == template.id }
        do {
            for item in existing {
                if let ev = ekEvents[item.id] { try ek.remove(ev, span: .thisEvent, commit: false) }
            }
            if !sameAlready {
                guard let calendar = shiftCalendar else {
                    toast = Toast(message: "没有可写入的日历")
                    return
                }
                let ev = EKEvent(eventStore: ek)
                let interval = template.interval(on: day, calendar: Calendar.current)
                ev.title = template.name
                ev.isAllDay = template.isAllDay
                ev.startDate = interval.start
                ev.endDate = template.isAllDay ? interval.start : interval.end
                ev.url = ShiftMarker.url(for: template.id)
                ev.calendar = calendar
                try ek.save(ev, span: .thisEvent, commit: false)
            }
            try ek.commit()
        } catch {
            ek.reset()
            report(error)
        }
        reload()
    }

    func clearShifts(on day: Date) {
        let existing = agenda(for: day).shifts
        guard !existing.isEmpty else { return }
        do {
            for item in existing {
                if let ev = ekEvents[item.id] { try ek.remove(ev, span: .thisEvent, commit: false) }
            }
            try ek.commit()
        } catch {
            ek.reset()
            report(error)
        }
        reload()
    }

    /// Creates a dedicated "排班" calendar in the default account and selects it for shifts.
    func createShiftCalendar() {
        let calendar = EKCalendar(for: .event, eventStore: ek)
        calendar.title = "排班"
        calendar.cgColor = UIColor.systemIndigo.cgColor
        guard let source = ek.defaultCalendarForNewEvents?.source
                ?? ek.sources.first(where: { $0.sourceType == .local }) else {
            toast = Toast(message: "找不到可以建立日历的账户")
            return
        }
        calendar.source = source
        do {
            try ek.saveCalendar(calendar, commit: true)
            prefs.shiftCalendarID = calendar.calendarIdentifier
            toast = Toast(message: "已建立「排班」日历")
        } catch {
            report(error)
        }
        reload()
    }

    // MARK: - Quick add

    func add(_ result: QuickAddParser.Result) {
        guard !result.title.isEmpty || result.kind == .shift else { return }
        switch result.kind {
        case .shift:
            if let name = result.shiftName, let template = prefs.template(named: name) {
                applyShift(template, on: result.day)
                toast = Toast(message: "已排\(template.name)：\(Fmt.relativeDay(result.day))")
            }
        case .event, .allDayEvent:
            var draft = EventDraft()
            draft.title = result.title
            draft.isAllDay = result.kind == .allDayEvent
            draft.start = result.start ?? result.day
            draft.end = result.end ?? draft.start.addingTimeInterval(Double(prefs.defaultEventMinutes) * 60)
            if draft.isAllDay { draft.end = draft.start }
            draft.calendarID = calendar(matching: result.calendarHint, in: editableCalendars)?.calendarIdentifier
            if let id = save(draft) {
                toast = Toast(message: "已新增日程「\(draft.title)」") { [weak self] in self?.removeEvent(identifier: id) }
            }
        case .reminder:
            var draft = TaskDraft()
            draft.title = result.title
            draft.hasDate = true
            draft.hasTime = result.hasTime
            draft.due = result.start ?? result.day
            draft.priority = result.priority
            draft.durationMinutes = result.durationMinutes ?? prefs.defaultTaskMinutes
            draft.listID = calendar(matching: result.calendarHint, in: editableLists)?.calendarIdentifier
            if let id = save(draft) {
                toast = Toast(message: "已新增待办「\(draft.title)」") { [weak self] in self?.removeReminder(identifier: id) }
            }
        }
    }

    private func removeEvent(identifier: String) {
        guard let ev = ek.event(withIdentifier: identifier) else { return }
        try? ek.remove(ev, span: .thisEvent, commit: true)
        reload()
    }

    private func removeReminder(identifier: String) {
        guard let r = ek.calendarItem(withIdentifier: identifier) as? EKReminder else { return }
        try? ek.remove(r, commit: true)
        reload()
    }

    private func report(_ error: Error) {
        toast = Toast(message: "操作失败：\(error.localizedDescription)")
    }
}
