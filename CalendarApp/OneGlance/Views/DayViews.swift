import SwiftUI
import GlanceCore

/// The day page: a tray with everything that has no clock time (shift,
/// all-day events, tasks, overdue items) above a time grid, or one list
/// with all of it.
struct DayView: View {
    @EnvironmentObject private var store: CalendarStore
    @EnvironmentObject private var prefs: Preferences
    let day: Date

    var body: some View {
        let agenda = store.agenda(for: day)
        Group {
            if prefs.dayStyle == .timeline {
                VStack(spacing: 0) {
                    DayTray(agenda: agenda)
                    Divider()
                    TimeGrid(days: [day], compact: false)
                }
            } else {
                AgendaList(agenda: agenda)
            }
        }
    }
}

// MARK: - Tray

struct DayTray: View {
    @EnvironmentObject private var store: CalendarStore
    @EnvironmentObject private var prefs: Preferences
    let agenda: DayAgenda
    @State private var showInbox = false
    @State private var collapsed = false

    var body: some View {
        let inbox = store.inbox
        let hasItems = !agenda.shifts.isEmpty || !agenda.allDay.isEmpty || agenda.pendingTaskCount > 0
            || (prefs.showCompleted && !agenda.completed.isEmpty)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(summary).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if !inbox.isEmpty {
                    Button {
                        withAnimation(.snappy) { showInbox.toggle() }
                    } label: {
                        Label("未排期 \(inbox.count)", systemImage: showInbox ? "tray.full.fill" : "tray.full")
                            .font(.caption.weight(.medium))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
                if hasItems {
                    Button {
                        withAnimation(.snappy) { collapsed.toggle() }
                    } label: {
                        Image(systemName: collapsed ? "chevron.down" : "chevron.up").font(.caption)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                }
            }
            if !collapsed && hasItems {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(agenda.shifts) { ShiftBanner(event: $0) }
                        FlowLayout(spacing: 6) {
                            ForEach(agenda.allDay) { EventChip(event: $0) }
                            ForEach(agenda.overdue) { TaskChip(task: $0, overdue: true) }
                            ForEach(agenda.untimedTasks) { TaskChip(task: $0) }
                            ForEach(agenda.timedTasks) { TaskChip(task: $0, showTime: true) }
                            if prefs.showCompleted {
                                ForEach(agenda.completed) { TaskChip(task: $0) }
                            }
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: 190)
                .fixedSize(horizontal: false, vertical: true)
            }
            if showInbox && !inbox.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("长按拖到时间轴即可排进当天；也可以拖到上方日期").font(.caption2).foregroundStyle(.secondary)
                    ScrollView {
                        FlowLayout(spacing: 6) {
                            ForEach(inbox) { TaskChip(task: $0) }
                        }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(maxHeight: 140)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .padding(8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private var summary: String {
        var parts: [String] = []
        if !agenda.allDay.isEmpty { parts.append("全天 \(agenda.allDay.count)") }
        let todo = agenda.untimedTasks.count + agenda.timedTasks.count
        if todo > 0 { parts.append("待办 \(todo)") }
        if !agenda.overdue.isEmpty { parts.append("逾期 \(agenda.overdue.count)") }
        if !agenda.completed.isEmpty { parts.append("已完成 \(agenda.completed.count)") }
        return parts.isEmpty ? "没有全天事项或待办" : parts.joined(separator: " · ")
    }
}

struct ShiftBanner: View {
    @EnvironmentObject private var store: CalendarStore
    @Environment(\.openEditor) private var openEditor
    let event: EventItem

    var body: some View {
        if let template = event.shift {
            HStack(spacing: 8) {
                ShiftBadge(template: template, size: 12)
                Text(template.name).font(.subheadline.weight(.semibold))
                Text(event.isAllDay || template.isAllDay ? "全天" : Fmt.range(event.start, event.end))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if let rest = store.shortRest(before: event) {
                    Label("距上一班 \(String(format: "%.1f", rest)) 小时", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(hex: template.colorHex).opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
            .onTapGesture { openEditor(.event(store.draft(for: event), event)) }
        }
    }
}

struct EventChip: View {
    @EnvironmentObject private var store: CalendarStore
    @Environment(\.openEditor) private var openEditor
    let event: EventItem

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(event.color).frame(width: 7, height: 7)
            Text(event.title).lineLimit(1)
        }
        .font(.subheadline)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(event.color.opacity(0.16), in: Capsule())
        .contentShape(Capsule())
        .onTapGesture { openEditor(.event(store.draft(for: event), event)) }
    }
}

struct TaskChip: View {
    @EnvironmentObject private var store: CalendarStore
    @Environment(\.openEditor) private var openEditor
    let task: TaskItem
    var overdue = false
    var showTime = false

    var body: some View {
        HStack(spacing: 5) {
            Button {
                withAnimation(.snappy) { store.toggle(task) }
            } label: {
                Image(systemName: task.isCompleted ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(task.color)
                    .imageScale(.medium)
            }
            .buttonStyle(.plain)
            if !task.priorityMark.isEmpty {
                Text(task.priorityMark).foregroundStyle(.red).font(.caption.bold())
            }
            Text(task.title)
                .lineLimit(1)
                .strikethrough(task.isCompleted)
                .foregroundStyle(task.isCompleted ? .secondary : .primary)
            if showTime, let due = task.due {
                Text(Fmt.hm(due)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            if overdue, let due = task.due {
                Text(Fmt.md(due)).font(.caption2).foregroundStyle(.red)
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(task.color.opacity(task.isCompleted ? 0.06 : 0.13), in: Capsule())
        .overlay(Capsule().strokeBorder(overdue ? Color.red.opacity(0.55) : Color.clear))
        .contentShape(Capsule())
        .onTapGesture { openEditor(.task(store.draft(for: task), task)) }
        .draggable("task:\(task.id)") {
            Text(task.title)
                .font(.subheadline)
                .padding(8)
                .background(.regularMaterial, in: Capsule())
        }
        .contextMenu { TaskMenu(task: task) }
    }
}

/// Quick rescheduling without opening anything.
struct TaskMenu: View {
    @EnvironmentObject private var store: CalendarStore
    let task: TaskItem
    private let cal = Calendar.current

    var body: some View {
        Button { store.toggle(task) } label: {
            Label(task.isCompleted ? "标为未完成" : "完成", systemImage: "checkmark.circle")
        }
        Button { store.schedule(task, at: cal.startOfDay(for: Date()), hasTime: false) } label: {
            Label("今天", systemImage: "sun.max")
        }
        Button { store.postpone(task, days: 1) } label: {
            Label("推迟一天", systemImage: "arrow.turn.down.right")
        }
        Button {
            let monday = cal.date(byAdding: .day, value: 7, to: cal.startOfWeek(containing: Date())) ?? Date()
            store.schedule(task, at: monday, hasTime: false)
        } label: {
            Label("下周", systemImage: "calendar.badge.clock")
        }
        Button { store.schedule(task, at: nil, hasTime: false) } label: {
            Label("移到未排期", systemImage: "tray")
        }
        Divider()
        Button(role: .destructive) { store.delete(task) } label: {
            Label("删除", systemImage: "trash")
        }
    }
}

/// Wraps chips onto as many lines as needed.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            let w = min(size.width, maxWidth)
            if x > 0, x + w > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += w + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: subviews.isEmpty ? 0 : y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            let w = min(size.width, bounds.width)
            if x > bounds.minX, x + w > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: w, height: size.height))
            x += w + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// MARK: - List style

/// Everything for the day in one scrolling list, with free time between
/// appointments spelled out.
struct AgendaList: View {
    @EnvironmentObject private var store: CalendarStore
    @EnvironmentObject private var prefs: Preferences
    let agenda: DayAgenda
    @State private var showInbox = false
    @State private var pendingDelete: EventItem? = nil

    var body: some View {
        List {
            if !agenda.shifts.isEmpty || !agenda.allDay.isEmpty {
                Section("班次与全天") {
                    ForEach(agenda.shifts) { ShiftBanner(event: $0).listRowSeparator(.hidden) }
                    ForEach(agenda.allDay) { event in
                        EventRow(event: event, showTime: false)
                            .swipeActions { deleteButton(event) }
                    }
                }
            }
            if !agenda.overdue.isEmpty {
                Section("逾期") {
                    ForEach(agenda.overdue) { TaskRow(task: $0, overdue: true) }
                }
            }
            if !agenda.untimedTasks.isEmpty {
                Section("待办") {
                    ForEach(agenda.untimedTasks) { TaskRow(task: $0) }
                }
            }
            Section("时间表") {
                let rows = scheduleRows
                if rows.isEmpty {
                    Text("没有定时的日程").foregroundStyle(.secondary).font(.subheadline)
                }
                ForEach(rows) { row in
                    switch row.kind {
                    case .event(let e):
                        EventRow(event: e, showTime: true)
                            .swipeActions { deleteButton(e) }
                    case .task(let t):
                        TaskRow(task: t)
                    case .gap(let minutes):
                        Label("空闲 \(DurationText.chinese(minutes: minutes))", systemImage: "cup.and.saucer")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .listRowSeparator(.hidden)
                    case .now(let date):
                        HStack(spacing: 6) {
                            Circle().fill(.red).frame(width: 7, height: 7)
                            Text("现在 \(Fmt.hm(date))").font(.caption.bold()).foregroundStyle(.red)
                            Rectangle().fill(.red).frame(height: 1)
                        }
                        .listRowSeparator(.hidden)
                    }
                }
            }
            if prefs.showCompleted && !agenda.completed.isEmpty {
                Section("已完成") {
                    ForEach(agenda.completed) { TaskRow(task: $0) }
                }
            }
            if !store.inbox.isEmpty {
                Section(isExpanded: $showInbox) {
                    ForEach(store.inbox) { TaskRow(task: $0, offerToday: true) }
                } header: {
                    Text("未排期 \(store.inbox.count)")
                }
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 34)
        .scrollDismissesKeyboard(.interactively)
        .confirmationDialog("删除这个日程？", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                            titleVisibility: .visible, presenting: pendingDelete) { event in
            Button("删除「\(event.title)」", role: .destructive) { store.delete(event) }
        }
    }

    private func deleteButton(_ event: EventItem) -> some View {
        Button(role: .destructive) { pendingDelete = event } label: { Label("删除", systemImage: "trash") }
            .tint(.red)
            .disabled(!event.canEdit)
    }

    struct ScheduleRow: Identifiable {
        enum Kind { case event(EventItem), task(TaskItem), gap(Int), now(Date) }
        let id: String
        let kind: Kind
    }

    /// Timed events and tasks in order, with free-time and "now" rows in between.
    private var scheduleRows: [ScheduleRow] {
        let cal = Calendar.current
        let day = agenda.day
        typealias Entry = (start: Date, end: Date, row: ScheduleRow)
        var entries: [Entry] = agenda.timed.map { e in
            (start: e.start, end: e.end, row: ScheduleRow(id: "e" + e.id, kind: .event(e)))
        }
        for t in agenda.timedTasks {
            guard let due = t.due, let end = t.end else { continue }
            entries.append((start: due, end: end, row: ScheduleRow(id: "t" + t.id, kind: .task(t))))
        }
        entries.sort { $0.start < $1.start }

        var rows: [ScheduleRow] = []
        var cursor: Date?
        let now = Date()
        var nowPlaced = !cal.isDate(now, inSameDayAs: day)
        for entry in entries {
            if !nowPlaced, now < entry.start {
                rows.append(ScheduleRow(id: "now", kind: .now(now)))
                nowPlaced = true
            }
            if let c = cursor {
                let gap = Int(entry.start.timeIntervalSince(c) / 60)
                if gap >= 30 { rows.append(ScheduleRow(id: "gap\(c.timeIntervalSince1970)", kind: .gap(gap))) }
            }
            rows.append(entry.row)
            cursor = max(cursor ?? entry.end, entry.end)
        }
        if !nowPlaced, !entries.isEmpty {
            rows.append(ScheduleRow(id: "now", kind: .now(now)))
        }
        return rows
    }
}

struct EventRow: View {
    @EnvironmentObject private var store: CalendarStore
    @Environment(\.openEditor) private var openEditor
    let event: EventItem
    let showTime: Bool

    var body: some View {
        HStack(spacing: 10) {
            if showTime {
                VStack(alignment: .trailing, spacing: 0) {
                    Text(Fmt.hm(event.start)).font(.subheadline.monospacedDigit())
                    Text(Fmt.hm(event.end)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                .frame(width: 44, alignment: .trailing)
            }
            RoundedRectangle(cornerRadius: 2).fill(event.color).frame(width: 4)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    if let shift = event.shift { ShiftBadge(template: shift, size: 10) }
                    Text(event.title).font(.subheadline.weight(.medium)).lineLimit(2)
                }
                let detail = [event.location, event.calendarTitle].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                if !detail.isEmpty {
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if event.isRecurring { Image(systemName: "repeat").font(.caption2).foregroundStyle(.secondary) }
        }
        .contentShape(Rectangle())
        .onTapGesture { openEditor(.event(store.draft(for: event), event)) }
    }
}

struct TaskRow: View {
    @EnvironmentObject private var store: CalendarStore
    @Environment(\.openEditor) private var openEditor
    let task: TaskItem
    var overdue = false
    var offerToday = false

    var body: some View {
        HStack(spacing: 10) {
            Button {
                withAnimation(.snappy) { store.toggle(task) }
            } label: {
                Image(systemName: task.isCompleted ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(task.color)
            }
            .buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    if !task.priorityMark.isEmpty { Text(task.priorityMark).foregroundStyle(.red).font(.caption.bold()) }
                    Text(task.title)
                        .font(.subheadline)
                        .strikethrough(task.isCompleted)
                        .foregroundStyle(task.isCompleted ? .secondary : .primary)
                        .lineLimit(2)
                }
                Text(detail).font(.caption).foregroundStyle(overdue ? .red : .secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .onTapGesture { openEditor(.task(store.draft(for: task), task)) }
        .draggable("task:\(task.id)")
        .contextMenu { TaskMenu(task: task) }
        .swipeActions(edge: .leading) {
            Button { store.toggle(task) } label: { Label("完成", systemImage: "checkmark") }.tint(.green)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { store.delete(task) } label: { Label("删除", systemImage: "trash") }
            if offerToday {
                Button { store.schedule(task, at: Calendar.current.startOfDay(for: Date()), hasTime: false) } label: {
                    Label("今天", systemImage: "sun.max")
                }
                .tint(.orange)
            } else {
                Button { store.postpone(task) } label: { Label("明天", systemImage: "arrow.turn.down.right") }
                    .tint(.indigo)
            }
        }
    }

    private var detail: String {
        var parts: [String] = []
        if let due = task.due {
            if task.hasTime {
                parts.append("\(Fmt.hm(due)) · \(DurationText.chinese(minutes: task.durationMinutes))")
            }
            if overdue { parts.append("原定 \(Fmt.md(due))") }
        }
        parts.append(task.listTitle)
        return parts.joined(separator: " · ")
    }
}
