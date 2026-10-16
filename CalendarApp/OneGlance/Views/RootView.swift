import SwiftUI
import GlanceCore

enum ViewMode: String, CaseIterable, Identifiable {
    case day = "日", week = "周", month = "月"
    var id: String { rawValue }
}

/// What the editor sheet shows. Editing is always a half-height sheet over
/// the single main screen, never a pushed page.
enum EditRequest: Identifiable {
    case event(CalendarStore.EventDraft, EventItem?)
    case task(CalendarStore.TaskDraft, TaskItem?)

    var id: String {
        switch self {
        case .event(let d, _): return "e:" + (d.existingID ?? "new\(d.start.timeIntervalSince1970)")
        case .task(let d, _): return "t:" + (d.existingID ?? "new\(d.due.timeIntervalSince1970)")
        }
    }
}

private struct OpenEditorKey: EnvironmentKey {
    static let defaultValue: (EditRequest) -> Void = { _ in }
}

extension EnvironmentValues {
    var openEditor: (EditRequest) -> Void {
        get { self[OpenEditorKey.self] }
        set { self[OpenEditorKey.self] = newValue }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: CalendarStore
    @EnvironmentObject private var prefs: Preferences
    @State private var mode: ViewMode = .day
    @State private var selectedDay = Calendar.current.startOfDay(for: Date())
    @State private var editing: EditRequest? = nil
    @State private var showSettings = false

    var body: some View {
        Group {
            if store.needsPermission {
                PermissionView()
            } else {
                main
            }
        }
        .onOpenURL { url in
            // oneglance://today from the widget
            if url.host == "today" {
                selectedDay = Calendar.current.startOfDay(for: Date())
                mode = .day
            }
        }
    }

    private var main: some View {
        VStack(spacing: 0) {
            HeaderView(mode: $mode, selectedDay: $selectedDay, showSettings: $showSettings)
            Divider()
            Group {
                switch mode {
                case .day: DayView(day: selectedDay)
                case .week: WeekView(selectedDay: $selectedDay, mode: $mode)
                case .month: MonthView(selectedDay: $selectedDay, mode: $mode)
                }
            }
            .frame(maxHeight: .infinity)
            .overlay(alignment: .bottom) { toastView }
            QuickAddBar(defaultDay: selectedDay)
        }
        .environment(\.openEditor, { editing = $0 })
        .sheet(item: $editing) { request in
            EditorSheet(request: request)
                .environmentObject(store)
                .environmentObject(prefs)
        }
        .sheet(isPresented: $showSettings, onDismiss: { store.reload() }) {
            SettingsSheet()
                .environmentObject(store)
                .environmentObject(prefs)
        }
        .onChange(of: selectedDay) { _, day in store.ensureLoaded(around: day) }
    }

    @ViewBuilder private var toastView: some View {
        if let toast = store.toast {
            HStack(spacing: 12) {
                Text(toast.message).font(.subheadline).lineLimit(2)
                if let undo = toast.undo {
                    Button("撤销") {
                        undo()
                        store.toast = nil
                    }
                    .font(.subheadline.bold())
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .shadow(radius: 4, y: 2)
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task(id: toast.id) {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if store.toast?.id == toast.id {
                    withAnimation { store.toast = nil }
                }
            }
        }
    }
}

// MARK: - Header

struct HeaderView: View {
    @EnvironmentObject private var store: CalendarStore
    @EnvironmentObject private var prefs: Preferences
    @Binding var mode: ViewMode
    @Binding var selectedDay: Date
    @Binding var showSettings: Bool
    private let cal = Calendar.current

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 4) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.title3.bold()).lineLimit(1)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                Button { step(-1) } label: { Image(systemName: "chevron.left") }
                    .frame(width: 34, height: 34)
                    .accessibilityLabel("上一页")
                Button("今天") { withAnimation { selectedDay = cal.startOfDay(for: Date()) } }
                    .font(.subheadline.weight(.medium))
                    .disabled(cal.isDateInToday(selectedDay) && mode == .day)
                Button { step(1) } label: { Image(systemName: "chevron.right") }
                    .frame(width: 34, height: 34)
                    .accessibilityLabel("下一页")
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    .frame(width: 34, height: 34)
                    .accessibilityLabel("设置")
            }
            HStack(spacing: 8) {
                Picker("视图", selection: $mode) {
                    ForEach(ViewMode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                if mode == .day {
                    Button {
                        prefs.dayStyle = prefs.dayStyle == .timeline ? .list : .timeline
                    } label: {
                        Image(systemName: prefs.dayStyle == .timeline ? "list.bullet" : "calendar.day.timeline.left")
                            .frame(width: 34, height: 28)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel(prefs.dayStyle == .timeline ? "切换到清单" : "切换到时间轴")
                }
            }
            if mode == .day {
                WeekStrip(selectedDay: $selectedDay)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 6)
    }

    private var title: String {
        switch mode {
        case .day:
            return Fmt.mdw(selectedDay)
        case .week:
            let days = cal.weekDays(containing: selectedDay)
            guard let first = days.first, let last = days.last else { return "" }
            return "\(Fmt.md(first))–\(cal.isSameMonth(first, last) ? "\(cal.component(.day, from: last))日" : Fmt.md(last))"
        case .month:
            return Fmt.ym(selectedDay)
        }
    }

    private var subtitle: String {
        let a = store.agenda(for: selectedDay)
        var parts: [String] = []
        if mode != .day { parts.append(Fmt.relativeDay(selectedDay)) }
        else if cal.isDateInToday(selectedDay) { parts.append("今天") }
        parts += a.shifts.compactMap { $0.shift?.name }
        let events = a.timed.filter { $0.shift == nil }.count + a.allDay.count
        if events > 0 { parts.append("\(events)个日程") }
        if a.pendingTaskCount > 0 { parts.append("\(a.pendingTaskCount)个待办") }
        if a.overdue.count > 0 { parts.append("逾期\(a.overdue.count)") }
        if parts.isEmpty || (parts.count == 1 && parts[0] == "今天") { parts.append("没有安排") }
        return parts.joined(separator: " · ")
    }

    private func step(_ direction: Int) {
        let component: Calendar.Component
        let value: Int
        switch mode {
        case .day: component = .day; value = direction
        case .week: component = .day; value = 7 * direction
        case .month: component = .month; value = direction
        }
        withAnimation(.snappy) {
            selectedDay = cal.date(byAdding: component, value: value, to: selectedDay) ?? selectedDay
        }
    }
}

/// Seven days with shift badges and a load bar; swipe to change week.
struct WeekStrip: View {
    @EnvironmentObject private var store: CalendarStore
    @Binding var selectedDay: Date
    private let cal = Calendar.current

    var body: some View {
        HStack(spacing: 2) {
            ForEach(cal.weekDays(containing: selectedDay), id: \.self) { day in
                cell(day)
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                    .onTapGesture { withAnimation(.snappy) { selectedDay = day } }
                    .dropDestination(for: String.self) { items, _ in
                        DropHandler.schedule(items, store: store, day: day, minute: nil)
                    }
            }
        }
        .gesture(
            DragGesture(minimumDistance: 30)
                .onEnded { value in
                    guard abs(value.translation.width) > abs(value.translation.height) else { return }
                    let weeks = value.translation.width < 0 ? 1 : -1
                    withAnimation(.snappy) {
                        selectedDay = cal.date(byAdding: .day, value: 7 * weeks, to: selectedDay) ?? selectedDay
                    }
                }
        )
    }

    private func cell(_ day: Date) -> some View {
        let selected = cal.isDate(day, inSameDayAs: selectedDay)
        let today = cal.isDateInToday(day)
        let agenda = store.agenda(for: day)
        let shift = agenda.shifts.first?.shift
        return VStack(spacing: 3) {
            Text(Fmt.weekdayLetter(day))
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text("\(cal.component(.day, from: day))")
                .font(.callout.monospacedDigit().weight(today || selected ? .bold : .regular))
                .foregroundStyle(selected ? Color.white : (today ? Color.accentColor : Color.primary))
                .frame(width: 30, height: 30)
                .background(Circle().fill(selected ? Color.accentColor : Color.clear))
            ZStack {
                if let shift {
                    ShiftBadge(template: shift, size: 10)
                } else {
                    Capsule()
                        .fill(Color.heat(store.loadLevel(for: day)))
                        .frame(width: 18, height: 4)
                }
            }
            .frame(height: 14)
        }
    }
}

struct ShiftBadge: View {
    let template: ShiftTemplate
    var size: CGFloat = 11

    var body: some View {
        Text(template.shortName.isEmpty ? String(template.name.prefix(1)) : template.shortName)
            .font(.system(size: size, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 3)
            .frame(minWidth: size + 5, minHeight: size + 3)
            .background(Color(hex: template.colorHex), in: RoundedRectangle(cornerRadius: 3))
    }
}

/// Drag-and-drop payloads are plain strings: "task:<reminder id>".
enum DropHandler {
    static func taskID(from payload: String) -> String? {
        payload.hasPrefix("task:") ? String(payload.dropFirst(5)) : nil
    }

    /// Schedules dropped tasks on `day`; `minute` nil keeps a timed task's time (or none).
    @MainActor @discardableResult
    static func schedule(_ items: [String], store: CalendarStore, day: Date, minute: Int?) -> Bool {
        let cal = Calendar.current
        var handled = false
        for payload in items {
            guard let id = taskID(from: payload), let task = store.tasks.first(where: { $0.id == id }) else { continue }
            if let minute {
                store.schedule(task, at: cal.date(onDay: day, minute: minute), hasTime: true)
            } else if task.hasTime, let due = task.due {
                store.schedule(task, at: cal.date(onDay: day, minute: Int(cal.minuteOfDay(due, relativeTo: due))), hasTime: true)
            } else {
                store.schedule(task, at: cal.startOfDay(for: day), hasTime: false)
            }
            handled = true
        }
        return handled
    }
}
