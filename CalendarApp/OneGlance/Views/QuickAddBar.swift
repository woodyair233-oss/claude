import SwiftUI
import GlanceCore

/// Always-visible input line. Shows what it understood before saving, so a
/// wrong guess (event vs task, time) can be fixed by tapping the first chip.
struct QuickAddBar: View {
    @EnvironmentObject private var store: CalendarStore
    @EnvironmentObject private var prefs: Preferences
    @Environment(\.openEditor) private var openEditor
    let defaultDay: Date

    @State private var text = ""
    @State private var override: QuickAddParser.Override = .automatic
    @FocusState private var focused: Bool

    private var parser: QuickAddParser {
        QuickAddParser(calendar: .current,
                       defaultEventMinutes: prefs.defaultEventMinutes,
                       shiftNames: prefs.shiftTemplates.map(\.name))
    }

    private var parsed: QuickAddParser.Result? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return parser.parse(trimmed, now: Date(), defaultDay: defaultDay, override: override)
    }

    var body: some View {
        let result = parsed
        VStack(spacing: 6) {
            if let result {
                preview(result)
            }
            HStack(spacing: 8) {
                if text.isEmpty {
                    Menu {
                        Button { newEvent() } label: { Label("新建日程", systemImage: "calendar.badge.plus") }
                        Button { newTask() } label: { Label("新建待办", systemImage: "checklist") }
                    } label: {
                        Image(systemName: "plus.circle").font(.title2)
                    }
                    .accessibilityLabel("新建")
                }
                TextField("快速新增：明天下午3点 开会 1小时", text: $text)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(submit)
                    .accessibilityIdentifier("quickAdd")
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Color(.secondarySystemBackground), in: Capsule())
                if let result {
                    Button(action: submit) {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }
                    .accessibilityLabel("新增")
                    .disabled(result.title.isEmpty && result.kind != .shift)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .onChange(of: text) { _, newValue in
            if newValue.isEmpty { override = .automatic }
        }
    }

    private func preview(_ r: QuickAddParser.Result) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Button {
                    switch r.kind {
                    case .event, .allDayEvent, .shift: override = .reminder
                    case .reminder: override = .event
                    }
                } label: {
                    Label(kindName(r.kind), systemImage: kindIcon(r.kind))
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color.accentColor.opacity(0.15), in: Capsule())
                }
                .buttonStyle(.plain)
                chip(Fmt.relativeDay(r.day), "calendar")
                if let time = timeText(r) { chip(time, "clock") }
                if r.kind == .reminder, let d = r.durationMinutes {
                    chip("约\(DurationText.chinese(minutes: d))", "hourglass")
                }
                if let target = targetName(r) { chip(target, "tray") }
                if r.priority > 0 {
                    chip(r.priority == 1 ? "高优先" : (r.priority == 5 ? "中优先" : "低优先"), "exclamationmark")
                }
                if r.title.isEmpty && r.kind != .shift {
                    Text("请输入标题").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func chip(_ text: String, _ icon: String) -> some View {
        Label(text, systemImage: icon)
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color(.secondarySystemBackground), in: Capsule())
    }

    private func kindName(_ kind: QuickAddParser.Kind) -> String {
        switch kind {
        case .event: return "日程"
        case .allDayEvent: return "全天日程"
        case .reminder: return "待办"
        case .shift: return "班次"
        }
    }

    private func kindIcon(_ kind: QuickAddParser.Kind) -> String {
        switch kind {
        case .event, .allDayEvent: return "calendar"
        case .reminder: return "checkmark.circle"
        case .shift: return "person.badge.clock"
        }
    }

    private func timeText(_ r: QuickAddParser.Result) -> String? {
        switch r.kind {
        case .event:
            guard let s = r.start, let e = r.end else { return nil }
            return Fmt.range(s, e)
        case .allDayEvent:
            return "全天"
        case .reminder:
            return r.start.map { Fmt.hm($0) }
        case .shift:
            return r.shiftName.flatMap { prefs.template(named: $0)?.timeText }
        }
    }

    private func targetName(_ r: QuickAddParser.Result) -> String? {
        switch r.kind {
        case .event, .allDayEvent:
            return (store.calendar(matching: r.calendarHint, in: store.editableCalendars) ?? store.defaultEventCalendar)?.title
        case .reminder:
            return (store.calendar(matching: r.calendarHint, in: store.editableLists) ?? store.defaultReminderList)?.title
        case .shift:
            return store.shiftCalendar?.title
        }
    }

    private func submit() {
        guard let r = parsed, !r.title.isEmpty || r.kind == .shift else { return }
        store.add(r)
        text = ""
        override = .automatic
    }

    private func newEvent() {
        let cal = Calendar.current
        var draft = CalendarStore.EventDraft()
        let hour = cal.isDateInToday(defaultDay) ? cal.component(.hour, from: Date()) + 1 : 9
        draft.start = cal.date(onDay: defaultDay, minute: min(hour, 23) * 60)
        draft.end = draft.start.addingTimeInterval(Double(prefs.defaultEventMinutes) * 60)
        draft.calendarID = store.defaultEventCalendar?.calendarIdentifier
        openEditor(.event(draft, nil))
    }

    private func newTask() {
        var draft = CalendarStore.TaskDraft()
        draft.due = Calendar.current.startOfDay(for: defaultDay)
        draft.durationMinutes = prefs.defaultTaskMinutes
        draft.listID = store.defaultReminderList?.calendarIdentifier
        openEditor(.task(draft, nil))
    }
}
