import SwiftUI
import EventKit
import GlanceCore

struct SettingsSheet: View {
    @EnvironmentObject private var store: CalendarStore
    @EnvironmentObject private var prefs: Preferences
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach($prefs.shiftTemplates) { $template in
                        ShiftTemplateRow(template: $template)
                    }
                    .onDelete { prefs.shiftTemplates.remove(atOffsets: $0) }
                    .onMove { prefs.shiftTemplates.move(fromOffsets: $0, toOffset: $1) }
                    Button {
                        prefs.shiftTemplates.append(ShiftTemplate(name: "新班次", shortName: "新", colorHex: "#0EA5E9",
                                                                  startMinute: 9 * 60, durationMinutes: 8 * 60))
                    } label: {
                        Label("新增班次", systemImage: "plus")
                    }
                } header: {
                    Text("班次模板")
                } footer: {
                    Text("在月视图点「排班」，选班次后点日期即可排班；快速新增里输入「周五 夜班」也可以。")
                }

                Section("排班") {
                    Picker("写入日历", selection: $prefs.shiftCalendarID) {
                        Text("默认日历").tag(String?.none)
                        ForEach(store.editableCalendars, id: \.calendarIdentifier) { cal in
                            calendarLabel(cal).tag(Optional(cal.calendarIdentifier))
                        }
                    }
                    if !store.eventCalendars.contains(where: { $0.title == "排班" }) {
                        Button("建立「排班」专用日历") { store.createShiftCalendar() }
                    }
                    Stepper("两班最短间隔 \(Int(prefs.minimumRestHours)) 小时", value: $prefs.minimumRestHours, in: 0...24, step: 1)
                }

                Section {
                    Stepper("每天可用 \(Int(prefs.dayCapacityHours)) 小时", value: $prefs.dayCapacityHours, in: 2...16, step: 1)
                } header: {
                    Text("负荷热力图")
                } footer: {
                    Text("排满这么多小时，月视图的格子就显示为最深色。")
                }

                Section("新建时默认") {
                    Picker("日程写入", selection: $prefs.defaultEventCalendarID) {
                        Text("系统默认").tag(String?.none)
                        ForEach(store.editableCalendars, id: \.calendarIdentifier) { cal in
                            calendarLabel(cal).tag(Optional(cal.calendarIdentifier))
                        }
                    }
                    Picker("待办写入", selection: $prefs.defaultReminderListID) {
                        Text("系统默认").tag(String?.none)
                        ForEach(store.editableLists, id: \.calendarIdentifier) { list in
                            calendarLabel(list).tag(Optional(list.calendarIdentifier))
                        }
                    }
                    Stepper("日程时长 \(DurationText.chinese(minutes: prefs.defaultEventMinutes))",
                            value: $prefs.defaultEventMinutes, in: 15...240, step: 15)
                    Stepper("待办预估 \(DurationText.chinese(minutes: prefs.defaultTaskMinutes))",
                            value: $prefs.defaultTaskMinutes, in: 15...240, step: 15)
                }

                Section("显示") {
                    Toggle("显示已完成的待办", isOn: $prefs.showCompleted)
                }

                Section("显示的日历") {
                    ForEach(store.eventCalendars, id: \.calendarIdentifier) { cal in
                        Toggle(isOn: visibility(cal)) { calendarLabel(cal) }
                    }
                }

                if store.hasReminderAccess {
                    Section("显示的提醒事项列表") {
                        ForEach(store.reminderLists, id: \.calendarIdentifier) { list in
                            Toggle(isOn: visibility(list)) { calendarLabel(list) }
                        }
                    }
                } else {
                    Section("提醒事项") {
                        Text("没有提醒事项的访问权限，待办功能不可用。")
                        Button("打开系统设置") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .topBarLeading) { EditButton() }
            }
        }
    }

    private func calendarLabel(_ cal: EKCalendar) -> some View {
        Label {
            Text(cal.title)
        } icon: {
            Image(systemName: "circle.fill").foregroundStyle(Color(cgColor: cal.cgColor))
        }
    }

    private func visibility(_ cal: EKCalendar) -> Binding<Bool> {
        Binding {
            !prefs.hiddenCalendarIDs.contains(cal.calendarIdentifier)
        } set: { visible in
            if visible {
                prefs.hiddenCalendarIDs.remove(cal.calendarIdentifier)
            } else {
                prefs.hiddenCalendarIDs.insert(cal.calendarIdentifier)
            }
        }
    }
}

struct ShiftTemplateRow: View {
    @Binding var template: ShiftTemplate
    private let cal = Calendar.current

    var body: some View {
        DisclosureGroup {
            TextField("名称", text: $template.name)
            TextField("简称（1–2 字，显示在格子里）", text: $template.shortName)
            ColorPicker("颜色", selection: Binding(
                get: { Color(hex: template.colorHex) },
                set: { template.colorHex = $0.hexString }
            ), supportsOpacity: false)
            Toggle("全天（例如休息、年假）", isOn: $template.isAllDay)
            if !template.isAllDay {
                DatePicker("开始", selection: Binding(
                    get: { cal.date(onDay: Date(), minute: template.startMinute) },
                    set: { template.startMinute = Int(cal.minuteOfDay($0, relativeTo: $0)) }
                ), displayedComponents: .hourAndMinute)
                Stepper("时长 \(DurationText.chinese(minutes: template.durationMinutes))",
                        value: $template.durationMinutes, in: 30...(48 * 60), step: 30)
            }
        } label: {
            HStack {
                ShiftBadge(template: template)
                Text(template.name)
                Spacer()
                Text(template.timeText).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
    }
}

struct PermissionView: View {
    @EnvironmentObject private var store: CalendarStore

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "calendar.badge.checkmark")
                .font(.system(size: 60))
                .foregroundStyle(Color.accentColor)
            Text("一览").font(.largeTitle.bold())
            Text("直接读写系统的「日历」与「提醒事项」，所以和系统日历、iCloud 及其他账户实时同步，不会另存一份数据。")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 32)
            if store.eventAccess == .notDetermined || store.reminderAccess == .notDetermined {
                Button {
                    Task { await store.requestAccess() }
                } label: {
                    Text("允许访问日历与提醒事项").frame(maxWidth: 280)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            } else {
                Text("需要「完全访问」日历的权限。请到「设置 → 一览」打开日历与提醒事项。")
                    .multilineTextAlignment(.center)
                    .font(.callout)
                    .padding(.horizontal, 32)
                Button("打开设置") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .buttonStyle(.borderedProminent)
            }
            Spacer()
        }
    }
}
