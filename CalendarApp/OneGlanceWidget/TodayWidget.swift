import WidgetKit
import SwiftUI
import EventKit
import AppIntents
import GlanceCore

@main
struct OneGlanceWidgets: WidgetBundle {
    var body: some Widget {
        TodayWidget()
    }
}

struct TodayWidget: Widget {
    let kind = "TodayWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: TodayProvider()) { entry in
            TodayWidgetView(entry: entry)
                .containerBackground(for: .widget) { Color(.systemBackground) }
                .widgetURL(URL(string: "\(ShiftMarker.scheme)://today"))
        }
        .configurationDisplayName("今日一览")
        .description("今天的班次、日程和待办，可以直接勾选完成。")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - Data

struct TodayEntry: TimelineEntry {
    struct Line: Identifiable {
        let id: String
        let title: String
        let start: Date
        let end: Date
        let color: Color
    }

    struct TaskLine: Identifiable {
        let id: String
        let title: String
        let due: Date?
        let hasTime: Bool
        let overdue: Bool
        let color: Color
    }

    var date: Date
    var authorized: Bool
    var shift: Line?
    var allDay: [Line] = []
    var timed: [Line] = []
    var tasks: [TaskLine] = []

    /// Timed events that have not ended at the entry's date.
    var upcoming: [Line] { timed.filter { $0.end > date } }

    static let sample = TodayEntry(
        date: Date(), authorized: true,
        shift: Line(id: "s", title: "白班", start: Date(), end: Date().addingTimeInterval(9 * 3600), color: .orange),
        allDay: [],
        timed: [Line(id: "1", title: "科室会议", start: Date().addingTimeInterval(3600), end: Date().addingTimeInterval(5400), color: .blue)],
        tasks: [TaskLine(id: "t", title: "回复会诊", due: nil, hasTime: false, overdue: false, color: .green)])
}

struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry { .sample }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        if context.isPreview {
            completion(.sample)
            return
        }
        Task { completion(await TodayLoader.load(now: Date())) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        Task {
            let now = Date()
            let entry = await TodayLoader.load(now: now)
            // Re-render as events end so finished ones drop off the list
            let changes = entry.timed.map(\.end).filter { $0 > now }.sorted().prefix(12)
            let entries = ([now] + changes).map { date -> TodayEntry in
                var e = entry
                e.date = date
                return e
            }
            let cal = Calendar.current
            let tomorrow = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now)) ?? now.addingTimeInterval(86400)
            completion(Timeline(entries: entries, policy: .after(tomorrow.addingTimeInterval(60))))
        }
    }
}

/// The widget reads EventKit itself; it shares the app's calendar permission.
enum TodayLoader {
    static func load(now: Date) async -> TodayEntry {
        let store = EKEventStore()
        let cal = Calendar.current
        let start = cal.startOfDay(for: now)
        let end = cal.date(byAdding: .day, value: 1, to: start) ?? now
        let eventsOK = EKEventStore.authorizationStatus(for: .event) == .fullAccess
        let remindersOK = EKEventStore.authorizationStatus(for: .reminder) == .fullAccess
        var entry = TodayEntry(date: now, authorized: eventsOK)

        if eventsOK {
            let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
                .sorted { $0.startDate < $1.startDate }
            for ev in events {
                let line = TodayEntry.Line(id: "\(ev.eventIdentifier ?? "")|\(ev.startDate.timeIntervalSince1970)",
                                           title: ev.title ?? "", start: ev.startDate, end: ev.endDate,
                                           color: Color(cgColor: ev.calendar.cgColor))
                if ShiftMarker.isShift(ev.url) {
                    if entry.shift == nil, cal.isDate(ev.startDate, inSameDayAs: start) { entry.shift = line }
                    if !ev.isAllDay { entry.timed.append(line) }
                } else if ev.isAllDay {
                    entry.allDay.append(line)
                } else {
                    entry.timed.append(line)
                }
            }
        }

        if remindersOK {
            let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: end, calendars: nil)
            let reminders: [EKReminder] = await withCheckedContinuation { continuation in
                store.fetchReminders(matching: predicate) { continuation.resume(returning: $0 ?? []) }
            }
            var lines: [TodayEntry.TaskLine] = []
            for r in reminders {
                guard let comps = r.dueDateComponents, let due = cal.date(from: comps), due < end else { continue }
                lines.append(TodayEntry.TaskLine(id: r.calendarItemIdentifier, title: r.title ?? "",
                                                 due: due, hasTime: comps.hour != nil,
                                                 overdue: cal.startOfDay(for: due) < start,
                                                 color: Color(cgColor: r.calendar.cgColor)))
            }
            entry.tasks = lines.sorted { a, b in
                if a.overdue != b.overdue { return a.overdue }
                if a.hasTime != b.hasTime { return a.hasTime }
                return (a.due ?? .distantFuture) < (b.due ?? .distantFuture)
            }
        }
        return entry
    }
}

// MARK: - Completing a task from the widget

struct ToggleReminderIntent: AppIntent {
    static let title: LocalizedStringResource = "完成待办"

    @Parameter(title: "待办")
    var reminderID: String

    init() {}

    init(reminderID: String) {
        self.reminderID = reminderID
    }

    func perform() async throws -> some IntentResult {
        let store = EKEventStore()
        if let reminder = store.calendarItem(withIdentifier: reminderID) as? EKReminder {
            reminder.isCompleted.toggle()
            try store.save(reminder, commit: true)
        }
        return .result()
    }
}

// MARK: - Views

struct TodayWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodayEntry

    var body: some View {
        if !entry.authorized {
            VStack(spacing: 4) {
                Image(systemName: "calendar.badge.exclamationmark")
                Text("打开「一览」允许访问日历").font(.caption).multilineTextAlignment(.center)
            }
        } else {
            switch family {
            case .accessoryInline: inline
            case .accessoryRectangular: rectangular
            case .systemSmall: small
            default: list(maxRows: family == .systemLarge ? 12 : 4)
            }
        }
    }

    private var inline: some View {
        let parts = [entry.shift?.title,
                     entry.upcoming.first.map { "\(Fmt.hm($0.start)) \($0.title)" },
                     entry.tasks.isEmpty ? nil : "待办\(entry.tasks.count)"]
        return Text(parts.compactMap { $0 }.joined(separator: " · ").ifEmpty("今天没有安排"))
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Text(Fmt.mdw(entry.date)).font(.headline)
                if let shift = entry.shift { Text(shift.title).font(.caption.bold()) }
            }
            if let next = entry.upcoming.first {
                Text("\(Fmt.hm(next.start)) \(next.title)").font(.caption).lineLimit(1)
            }
            if !entry.tasks.isEmpty {
                Text("待办 \(entry.tasks.count)：\(entry.tasks[0].title)").font(.caption).lineLimit(1)
            } else if entry.upcoming.isEmpty {
                Text("今天没有安排").font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 4) {
            header
            if let next = entry.upcoming.first {
                VStack(alignment: .leading, spacing: 0) {
                    Text(Fmt.range(next.start, next.end)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    Text(next.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                }
                .padding(.leading, 6)
                .overlay(alignment: .leading) { Rectangle().fill(next.color).frame(width: 3) }
            }
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                Image(systemName: "checklist")
                Text(entry.tasks.isEmpty ? "没有待办" : "待办 \(entry.tasks.count)")
                if entry.upcoming.count > 1 {
                    Spacer()
                    Text("还有\(entry.upcoming.count - 1)项").foregroundStyle(.secondary)
                }
            }
            .font(.caption)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 4) {
            Text(Fmt.mdw(entry.date)).font(.subheadline.bold())
            Spacer(minLength: 0)
            if let shift = entry.shift {
                Text(shift.title)
                    .font(.caption2.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(shift.color, in: Capsule())
            }
        }
    }

    private func list(maxRows: Int) -> some View {
        let events = Array(entry.upcoming.prefix(maxRows))
        let taskRows = Array(entry.tasks.prefix(max(maxRows - events.count, 2)))
        return VStack(alignment: .leading, spacing: 4) {
            header
            if !entry.allDay.isEmpty {
                Text(entry.allDay.map(\.title).joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            ForEach(events) { line in
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 1.5).fill(line.color).frame(width: 3, height: 14)
                    Text(Fmt.hm(line.start)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    Text(line.title).font(.caption.weight(.medium)).lineLimit(1)
                }
            }
            ForEach(taskRows) { task in
                HStack(spacing: 6) {
                    Button(intent: ToggleReminderIntent(reminderID: task.id)) {
                        Image(systemName: "circle").foregroundStyle(task.color)
                    }
                    .buttonStyle(.plain)
                    Text(task.title).font(.caption).lineLimit(1)
                    Spacer(minLength: 0)
                    if task.overdue {
                        Text("逾期").font(.caption2).foregroundStyle(.red)
                    } else if task.hasTime, let due = task.due {
                        Text(Fmt.hm(due)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
            if events.isEmpty && taskRows.isEmpty {
                Text("今天没有安排了").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            let hidden = (entry.upcoming.count - events.count) + (entry.tasks.count - taskRows.count)
            if hidden > 0 {
                Text("还有 \(hidden) 项").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}

/// Same formatting as the app (the app's `Fmt` lives in the app target).
enum Fmt {
    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_Hans")
        f.dateFormat = format
        return f
    }

    private static let hmF = formatter("HH:mm")
    private static let mdwF = formatter("M月d日 EEE")

    static func hm(_ d: Date) -> String { hmF.string(from: d) }
    static func mdw(_ d: Date) -> String { mdwF.string(from: d) }
    static func range(_ s: Date, _ e: Date) -> String { "\(hm(s))–\(hm(e))" }
}
