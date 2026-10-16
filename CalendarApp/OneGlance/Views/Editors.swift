import SwiftUI
import EventKit
import GlanceCore

struct EditorSheet: View {
    let request: EditRequest

    var body: some View {
        switch request {
        case .event(let draft, let item):
            EventEditor(draft: draft, item: item)
        case .task(let draft, let item):
            TaskEditor(draft: draft, item: item)
        }
    }
}

struct EventEditor: View {
    @EnvironmentObject private var store: CalendarStore
    @Environment(\.dismiss) private var dismiss
    @State var draft: CalendarStore.EventDraft
    let item: EventItem?
    @State private var confirmDelete = false
    @FocusState private var titleFocused: Bool

    private var readOnly: Bool { item.map { !$0.canEdit } ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("标题", text: $draft.title)
                        .font(.headline)
                        .focused($titleFocused)
                    if let shift = item?.shift {
                        HStack {
                            ShiftBadge(template: shift)
                            Text("班次：\(shift.name)").foregroundStyle(.secondary)
                        }
                    }
                }
                Section {
                    Toggle("全天", isOn: $draft.isAllDay)
                    DatePicker("开始", selection: $draft.start,
                               displayedComponents: draft.isAllDay ? [.date] : [.date, .hourAndMinute])
                    DatePicker("结束", selection: $draft.end, in: draft.start...,
                               displayedComponents: draft.isAllDay ? [.date] : [.date, .hourAndMinute])
                    if !draft.isAllDay {
                        HStack(spacing: 6) {
                            ForEach([15, 30, 60, 90, 120], id: \.self) { minutes in
                                Button(minutes < 60 ? "\(minutes)分" : (minutes % 60 == 0 ? "\(minutes / 60)小时" : "1.5小时")) {
                                    draft.end = draft.start.addingTimeInterval(Double(minutes) * 60)
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                .font(.caption)
                            }
                        }
                    }
                } footer: {
                    if item?.isRecurring == true { Text("这是重复日程：只会修改这一次。") }
                }
                Section {
                    Picker("日历", selection: $draft.calendarID) {
                        ForEach(store.editableCalendars, id: \.calendarIdentifier) { cal in
                            Label {
                                Text(cal.title)
                            } icon: {
                                Image(systemName: "circle.fill").foregroundStyle(Color(cgColor: cal.cgColor))
                            }
                            .tag(Optional(cal.calendarIdentifier))
                        }
                    }
                    TextField("地点", text: $draft.location)
                    TextField("备注", text: $draft.notes, axis: .vertical)
                        .lineLimit(2...6)
                }
                if item != nil && !readOnly {
                    Section {
                        Button("删除日程", role: .destructive) { confirmDelete = true }
                    }
                }
                if readOnly {
                    Section { Text("这个日历是只读的（例如订阅或节假日日历），不能修改。").foregroundStyle(.secondary) }
                }
            }
            .disabled(readOnly)
            .navigationTitle(item == nil ? "新建日程" : "编辑日程")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        store.save(draft)
                        dismiss()
                    }
                    .disabled(readOnly)
                }
            }
            .onChange(of: draft.start) { old, new in
                // Keep the length when the start moves
                draft.end = draft.end.addingTimeInterval(new.timeIntervalSince(old))
            }
            .confirmationDialog("删除这个日程？", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("删除", role: .destructive) {
                    if let item { store.delete(item) }
                    dismiss()
                }
            }
            .onAppear { if item == nil { titleFocused = true } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

struct TaskEditor: View {
    @EnvironmentObject private var store: CalendarStore
    @Environment(\.dismiss) private var dismiss
    @State var draft: CalendarStore.TaskDraft
    let item: TaskItem?
    @State private var confirmDelete = false
    @FocusState private var titleFocused: Bool
    private let cal = Calendar.current

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("标题", text: $draft.title)
                        .font(.headline)
                        .focused($titleFocused)
                    if item != nil {
                        Toggle("已完成", isOn: $draft.isCompleted)
                    }
                }
                Section {
                    Toggle("日期", isOn: $draft.hasDate.animation())
                    if draft.hasDate {
                        DatePicker("日期", selection: $draft.due, displayedComponents: .date)
                        HStack(spacing: 6) {
                            quickDay("今天", 0)
                            quickDay("明天", 1)
                            quickDay("后天", 2)
                            Button("下周一") {
                                let monday = cal.date(byAdding: .day, value: 7, to: cal.startOfWeek(containing: Date())) ?? Date()
                                setDay(monday)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                        .font(.caption)
                        Toggle("时间", isOn: $draft.hasTime.animation())
                        if draft.hasTime {
                            DatePicker("时间", selection: $draft.due, displayedComponents: .hourAndMinute)
                            Stepper("预估时长 \(DurationText.chinese(minutes: draft.durationMinutes))",
                                    value: $draft.durationMinutes, in: 15...600, step: 15)
                        }
                    }
                } footer: {
                    if draft.hasDate && draft.hasTime {
                        Text("会在这个时间提醒你；预估时长决定它在时间轴上占多长（只保存在本机）。")
                    }
                }
                Section {
                    Picker("优先级", selection: $draft.priority) {
                        Text("无").tag(0)
                        Text("低").tag(9)
                        Text("中").tag(5)
                        Text("高").tag(1)
                    }
                    .pickerStyle(.segmented)
                    Picker("列表", selection: $draft.listID) {
                        ForEach(store.editableLists, id: \.calendarIdentifier) { list in
                            Label {
                                Text(list.title)
                            } icon: {
                                Image(systemName: "circle.fill").foregroundStyle(Color(cgColor: list.cgColor))
                            }
                            .tag(Optional(list.calendarIdentifier))
                        }
                    }
                    TextField("备注", text: $draft.notes, axis: .vertical)
                        .lineLimit(2...6)
                }
                if item != nil {
                    Section {
                        Button("删除待办", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .navigationTitle(item == nil ? "新建待办" : "编辑待办")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        store.save(draft)
                        dismiss()
                    }
                }
            }
            .confirmationDialog("删除这个待办？", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("删除", role: .destructive) {
                    if let item { store.delete(item) }
                    dismiss()
                }
            }
            .onAppear { if item == nil { titleFocused = true } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func quickDay(_ title: String, _ offset: Int) -> some View {
        Button(title) {
            setDay(cal.date(byAdding: .day, value: offset, to: cal.startOfDay(for: Date())) ?? Date())
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    /// Changes the date but keeps the chosen time of day.
    private func setDay(_ day: Date) {
        let minutes = Int(cal.minuteOfDay(draft.due, relativeTo: draft.due))
        draft.due = cal.date(onDay: day, minute: minutes)
    }
}
