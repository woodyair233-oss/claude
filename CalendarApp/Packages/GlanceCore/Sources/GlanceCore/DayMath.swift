import Foundation

/// Wall-clock helpers. Timeline positions are "minutes since midnight" on the
/// clock face (09:30 → 570), which keeps drawing and snapping simple.
public extension Calendar {
    /// Minutes since midnight of `day`. Dates on later days return values
    /// above 1440 so an event that ends tomorrow can be clipped by the caller.
    func minuteOfDay(_ date: Date, relativeTo day: Date) -> Double {
        let dayStart = startOfDay(for: day)
        let dateDayStart = startOfDay(for: date)
        let dayOffset = dateComponents([.day], from: dayStart, to: dateDayStart).day ?? 0
        let comps = dateComponents([.hour, .minute, .second], from: date)
        let minutes = Double((comps.hour ?? 0) * 60 + (comps.minute ?? 0)) + Double(comps.second ?? 0) / 60
        return Double(dayOffset * 1440) + minutes
    }

    /// The date at `minute` (may exceed 1440 or be negative) on `day`'s clock.
    func date(onDay day: Date, minute: Int) -> Date {
        let dayShift = Int((Double(minute) / 1440).rounded(.down))
        let within = minute - dayShift * 1440
        let base = date(byAdding: .day, value: dayShift, to: startOfDay(for: day)) ?? day
        return date(bySettingHour: within / 60, minute: within % 60, second: 0, of: base) ?? base
    }

    /// Seven consecutive days of the week containing `date`, honouring `firstWeekday`.
    func weekDays(containing date: Date) -> [Date] {
        let start = startOfWeek(containing: date)
        return (0..<7).compactMap { self.date(byAdding: .day, value: $0, to: start) }
    }

    func startOfWeek(containing date: Date) -> Date {
        let day = startOfDay(for: date)
        let weekday = component(.weekday, from: day)
        let back = (weekday - firstWeekday + 7) % 7
        return self.date(byAdding: .day, value: -back, to: day) ?? day
    }

    /// 42 days (6 weeks) covering the month of `date`, starting on the first weekday.
    func monthGrid(for date: Date) -> [Date] {
        let comps = dateComponents([.year, .month], from: date)
        let first = self.date(from: comps) ?? date
        let start = startOfWeek(containing: first)
        return (0..<42).compactMap { self.date(byAdding: .day, value: $0, to: start) }
    }

    func isSameMonth(_ a: Date, _ b: Date) -> Bool {
        isDate(a, equalTo: b, toGranularity: .month)
    }

    /// 1 = Monday … 7 = Sunday, independent of locale settings.
    func isoWeekday(_ date: Date) -> Int {
        let weekday = component(.weekday, from: date) // 1 = Sunday
        return weekday == 1 ? 7 : weekday - 1
    }
}

public enum Snap {
    /// Rounds minutes to the nearest multiple of `step`.
    public static func minutes(_ value: Double, step: Int) -> Int {
        let s = Double(max(step, 1))
        return Int((value / s).rounded()) * Int(s)
    }
}

public enum DurationText {
    /// "45分钟", "2小时", "1小时30分"
    public static func chinese(minutes: Int) -> String {
        let m = max(0, minutes)
        let h = m / 60, r = m % 60
        if h == 0 { return "\(r)分钟" }
        if r == 0 { return "\(h)小时" }
        return "\(h)小时\(r)分"
    }
}
