import SwiftUI
import GlanceCore

/// Snapshot of one event occurrence. Recurring events share an
/// `eventIdentifier`, so the id also includes the occurrence start.
struct EventItem: Identifiable, Hashable {
    let id: String
    let eventID: String
    var title: String
    var start: Date
    var end: Date
    var isAllDay: Bool
    var calendarID: String
    var calendarTitle: String
    var color: Color
    var location: String?
    var notes: String?
    var isRecurring: Bool
    var canEdit: Bool
    /// The shift template this event was created from (or whose name it has).
    var shift: ShiftTemplate?

    var durationMinutes: Int { Int(end.timeIntervalSince(start) / 60) }
}

/// Snapshot of one reminder.
struct TaskItem: Identifiable, Hashable {
    let id: String
    var title: String
    var notes: String?
    /// Due date; start of day when `hasTime` is false.
    var due: Date?
    var hasTime: Bool
    var isCompleted: Bool
    var completionDate: Date?
    /// EventKit scale: 0 none, 1 high, 5 medium, 9 low.
    var priority: Int
    var listID: String
    var listTitle: String
    var color: Color
    /// Planned length on the timeline. Reminders have no duration field, so
    /// this is kept on the device (see `CalendarStore.taskDurations`).
    var durationMinutes: Int

    var end: Date? { due.map { $0.addingTimeInterval(Double(durationMinutes) * 60) } }

    var priorityMark: String {
        switch priority {
        case 1...4: return "!!!"
        case 5: return "!!"
        case 6...9: return "!"
        default: return ""
        }
    }
}

/// Everything that belongs to one day, already sorted for display.
struct DayAgenda {
    var day: Date
    var shifts: [EventItem] = []
    var allDay: [EventItem] = []
    var timed: [EventItem] = []
    var overdue: [TaskItem] = []
    var untimedTasks: [TaskItem] = []
    var timedTasks: [TaskItem] = []
    var completed: [TaskItem] = []

    var pendingTaskCount: Int { overdue.count + untimedTasks.count + timedTasks.count }
    var isEmpty: Bool {
        shifts.isEmpty && allDay.isEmpty && timed.isEmpty && pendingTaskCount == 0 && completed.isEmpty
    }
}

enum Fmt {
    static let zh = Locale(identifier: "zh_Hans")

    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = zh
        f.dateFormat = format
        return f
    }

    private static let hmF = formatter("HH:mm")
    private static let mdF = formatter("M月d日")
    private static let mdwF = formatter("M月d日 EEE")
    private static let ymF = formatter("yyyy年M月")
    private static let weekdayF = formatter("EEEEE")

    static func hm(_ d: Date) -> String { hmF.string(from: d) }
    static func md(_ d: Date) -> String { mdF.string(from: d) }
    static func mdw(_ d: Date) -> String { mdwF.string(from: d) }
    static func ym(_ d: Date) -> String { ymF.string(from: d) }
    /// 一 二 三 … 日
    static func weekdayLetter(_ d: Date) -> String { weekdayF.string(from: d) }

    /// "09:00–10:30", "20:00–次日08:00", "09:00–10月20日 18:00"
    static func range(_ start: Date, _ end: Date) -> String {
        let cal = Calendar.current
        // An end at exactly midnight still belongs to the start's day
        let endRef = end == cal.startOfDay(for: end) && end > start ? end.addingTimeInterval(-1) : end
        if cal.isDate(start, inSameDayAs: endRef) { return "\(hm(start))–\(hm(end))" }
        if let next = cal.date(byAdding: .day, value: 1, to: start), cal.isDate(next, inSameDayAs: endRef) {
            return "\(hm(start))–次日\(hm(end))"
        }
        return "\(hm(start))–\(md(end)) \(hm(end))"
    }

    /// "今天" / "明天" / "10月18日 周日"
    static func relativeDay(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "今天" }
        if cal.isDateInTomorrow(d) { return "明天" }
        if cal.isDateInYesterday(d) { return "昨天" }
        return mdw(d)
    }
}

extension Color {
    init(hex: String) {
        let c = HexColor.rgb(hex) ?? (0.5, 0.5, 0.5)
        self.init(red: c.r, green: c.g, blue: c.b)
    }

    var hexString: String {
        let ui = UIColor(self)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        ui.getRed(&r, green: &g, blue: &b, alpha: &a)
        return HexColor.hex(r: Double(r), g: Double(g), b: Double(b))
    }

    /// Fill for the month heat map, level 0…4.
    static func heat(_ level: Int) -> Color {
        let opacity: [Double] = [0, 0.16, 0.32, 0.52, 0.78]
        return Color.orange.opacity(opacity[min(max(level, 0), 4)])
    }
}
