import Foundation

/// A reusable shift (白班, 夜班, 值班 …). Applying it to a day writes an
/// ordinary calendar event, so the shift also shows up in the system Calendar.
public struct ShiftTemplate: Codable, Identifiable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    /// One or two characters shown on month cells and the week strip.
    public var shortName: String
    public var colorHex: String
    /// Minutes after midnight the shift starts.
    public var startMinute: Int
    /// Length in minutes; may run past midnight (a night shift).
    public var durationMinutes: Int
    /// Days off and similar markers are written as all-day events.
    public var isAllDay: Bool

    public init(id: UUID = UUID(), name: String, shortName: String, colorHex: String,
                startMinute: Int, durationMinutes: Int, isAllDay: Bool = false) {
        self.id = id
        self.name = name
        self.shortName = shortName
        self.colorHex = colorHex
        self.startMinute = startMinute
        self.durationMinutes = durationMinutes
        self.isAllDay = isAllDay
    }

    public var endMinute: Int { startMinute + durationMinutes }

    /// Start and end on `day`'s clock; the end can fall on the next day.
    public func interval(on day: Date, calendar: Calendar) -> (start: Date, end: Date) {
        if isAllDay {
            let start = calendar.startOfDay(for: day)
            let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start
            return (start, end)
        }
        return (calendar.date(onDay: day, minute: startMinute),
                calendar.date(onDay: day, minute: endMinute))
    }

    /// "08:00–17:00", "20:00–次日08:00", "全天"
    public var timeText: String {
        if isAllDay { return "全天" }
        func hm(_ m: Int) -> String {
            let w = ((m % 1440) + 1440) % 1440
            return String(format: "%02d:%02d", w / 60, w % 60)
        }
        let nextDay = endMinute >= 1440 ? "次日" : ""
        return "\(hm(startMinute))–\(nextDay)\(hm(endMinute))"
    }

    public static let defaults: [ShiftTemplate] = [
        ShiftTemplate(id: UUID(uuidString: "5A1F0C2E-0001-4C1A-9E0B-000000000001")!,
                      name: "白班", shortName: "白", colorHex: "#F59E0B",
                      startMinute: 8 * 60, durationMinutes: 9 * 60),
        ShiftTemplate(id: UUID(uuidString: "5A1F0C2E-0002-4C1A-9E0B-000000000002")!,
                      name: "夜班", shortName: "夜", colorHex: "#6366F1",
                      startMinute: 20 * 60, durationMinutes: 12 * 60),
        ShiftTemplate(id: UUID(uuidString: "5A1F0C2E-0003-4C1A-9E0B-000000000003")!,
                      name: "值班", shortName: "值", colorHex: "#EF4444",
                      startMinute: 8 * 60, durationMinutes: 24 * 60),
        ShiftTemplate(id: UUID(uuidString: "5A1F0C2E-0004-4C1A-9E0B-000000000004")!,
                      name: "休息", shortName: "休", colorHex: "#10B981",
                      startMinute: 0, durationMinutes: 24 * 60, isAllDay: true),
    ]
}

/// Shift events carry `oneglance://shift/<template id>` in their URL field so
/// they can be recognised again (also by the widget) without a separate database.
public enum ShiftMarker {
    public static let scheme = "oneglance"

    public static func url(for templateID: UUID) -> URL {
        URL(string: "\(scheme)://shift/\(templateID.uuidString)")!
    }

    public static func templateID(from url: URL?) -> UUID? {
        guard let url, url.scheme == scheme, url.host == "shift" else { return nil }
        return UUID(uuidString: url.lastPathComponent)
    }

    public static func isShift(_ url: URL?) -> Bool { templateID(from: url) != nil }
}

public enum ShiftAnalysis {
    public struct Occurrence: Equatable, Sendable {
        public let templateID: UUID?
        public let start: Date
        public let end: Date
        public let isAllDay: Bool
        public init(templateID: UUID?, start: Date, end: Date, isAllDay: Bool) {
            self.templateID = templateID
            self.start = start
            self.end = end
            self.isAllDay = isAllDay
        }
    }

    /// Rest before each timed shift, in hours (nil for the first one or when
    /// the previous shift is unknown). All-day markers such as 休息 are ignored.
    public static func restBefore(_ shifts: [Occurrence]) -> [Double?] {
        var previousEnd: Date?
        var result: [Double?] = []
        for shift in shifts.sorted(by: { $0.start < $1.start }) {
            if shift.isAllDay {
                result.append(nil)
                continue
            }
            if let previousEnd {
                result.append(shift.start.timeIntervalSince(previousEnd) / 3600)
            } else {
                result.append(nil)
            }
            previousEnd = max(previousEnd ?? shift.end, shift.end)
        }
        return result
    }

    public struct Summary: Equatable, Sendable {
        public var countByTemplate: [UUID: Int] = [:]
        public var totalWorkMinutes: Int = 0
    }

    /// Counts per template and total timed minutes for shifts starting in `interval`.
    public static func summary(_ shifts: [Occurrence], in interval: DateInterval) -> Summary {
        var summary = Summary()
        for shift in shifts where shift.start >= interval.start && shift.start < interval.end {
            if let id = shift.templateID { summary.countByTemplate[id, default: 0] += 1 }
            if !shift.isAllDay {
                summary.totalWorkMinutes += Int(shift.end.timeIntervalSince(shift.start) / 60)
            }
        }
        return summary
    }
}

public enum HexColor {
    /// Parses "#RRGGBB" / "RRGGBB" into 0…1 components.
    public static func rgb(_ hex: String) -> (r: Double, g: Double, b: Double)? {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        return (Double((value >> 16) & 0xFF) / 255,
                Double((value >> 8) & 0xFF) / 255,
                Double(value & 0xFF) / 255)
    }

    public static func hex(r: Double, g: Double, b: Double) -> String {
        func c(_ v: Double) -> Int { Int((min(max(v, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", c(r), c(g), c(b))
    }
}
