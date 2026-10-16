import Foundation

/// Turns one line such as "明天下午3点 开会 1小时 #工作" into something that can
/// be saved as an event, a reminder or a shift.
public struct QuickAddParser: Sendable {
    public enum Kind: String, Sendable, Equatable {
        case event, allDayEvent, reminder, shift
    }

    public enum Override: Sendable, Equatable {
        case automatic, event, reminder
    }

    public struct Result: Equatable, Sendable {
        public var kind: Kind
        public var title: String
        /// Start of the target day.
        public var day: Date
        /// Event start, or the reminder's due time when `hasTime`.
        public var start: Date?
        /// Event end (nil for reminders).
        public var end: Date?
        public var hasExplicitDate: Bool
        public var hasTime: Bool
        public var durationMinutes: Int?
        /// EventKit scale: 0 none, 1 high, 5 medium, 9 low.
        public var priority: Int
        /// Text after "#", matched against calendar / list names by the app.
        public var calendarHint: String?
        /// Template name when `kind == .shift`.
        public var shiftName: String?
    }

    public var calendar: Calendar
    public var defaultEventMinutes: Int
    /// Names (and short names) of shift templates, so "周五 夜班" applies a shift.
    public var shiftNames: [String]

    public init(calendar: Calendar, defaultEventMinutes: Int = 60, shiftNames: [String] = []) {
        self.calendar = calendar
        self.defaultEventMinutes = defaultEventMinutes
        self.shiftNames = shiftNames
    }

    // MARK: - Parsing

    public func parse(_ input: String, now: Date, defaultDay: Date,
                      override: Override = .automatic) -> Result {
        var text = " " + input.replacingOccurrences(of: "\u{3000}", with: " ") + " "
        let today = calendar.startOfDay(for: now)

        // 1. Explicit kind prefix: "待办 买药", "todo: call"
        var forcedReminder = false
        if let m = Regex.first(#"^\s*(待办|提醒我?|任务|todo|task)\s*[:：]?\s*"#, in: text) {
            forcedReminder = true
            text.replaceSubrange(m.range, with: " ")
        }

        // 2. "#日历名"
        var calendarHint: String?
        if let m = Regex.first(#"[#＃]([^\s#＃]+)"#, in: text) {
            calendarHint = m[1]
            text.replaceSubrange(m.range, with: " ")
        }

        // 3. Priority "!" "!!" "!!!" (as in the Reminders app)
        var priority = 0
        if let m = Regex.first(#"(?:^|\s)([!！]{1,3})(?=\s|$)"#, in: text) {
            switch (m[1] ?? "").count {
            case 3: priority = 1
            case 2: priority = 5
            default: priority = 9
            }
            text.replaceSubrange(m.range, with: " ")
        }

        // 4. All day
        var allDay = false
        if let m = Regex.first(#"全天|整天|all[\s-]?day"#, in: text) {
            allDay = true
            text.replaceSubrange(m.range, with: " ")
        }

        // 5. Date
        var day: Date?
        var dayPart: DayPart?
        if let found = parseDate(&text, today: today) {
            day = found.day
            dayPart = found.part
        }

        // 6. Duration (before times, so "1小时" is never read as a clock time)
        var duration: Int?
        if let d = parseDuration(&text) { duration = d }

        // 7. Time range, else a single time
        var startMinute: Int?
        var endMinute: Int?
        if let range = parseTimeRange(&text, hint: dayPart) {
            startMinute = range.0
            endMinute = range.1
        } else if let t = parseSingleTime(&text, hint: dayPart) {
            startMinute = t
        }

        let title = cleanTitle(text)
        let targetDay = day ?? calendar.startOfDay(for: defaultDay)
        let hasTime = startMinute != nil

        // Kind
        var kind: Kind
        var shiftName: String?
        switch override {
        case .reminder:
            kind = .reminder
        case .event:
            kind = hasTime ? .event : .allDayEvent
        case .automatic:
            if forcedReminder {
                kind = .reminder
            } else if allDay {
                kind = .allDayEvent
            } else if !hasTime, let name = matchShift(title) {
                kind = .shift
                shiftName = name
            } else {
                // A clock time means an appointment; otherwise it is a task
                // (a bare duration becomes the task's estimated length).
                kind = hasTime ? .event : .reminder
            }
        }

        var start: Date?
        var end: Date?
        if let s = startMinute {
            start = calendar.date(onDay: targetDay, minute: s)
            if kind == .event {
                let e = endMinute ?? (s + (duration ?? defaultEventMinutes))
                end = calendar.date(onDay: targetDay, minute: e)
            }
        }
        if kind == .allDayEvent {
            start = targetDay
            end = calendar.date(byAdding: .day, value: 1, to: targetDay)
        }

        return Result(kind: kind,
                      title: title,
                      day: targetDay,
                      start: start,
                      end: end,
                      hasExplicitDate: day != nil,
                      hasTime: hasTime && kind != .allDayEvent,
                      durationMinutes: endMinute.flatMap { e in startMinute.map { e - $0 } } ?? duration,
                      priority: priority,
                      calendarHint: calendarHint,
                      shiftName: shiftName)
    }

    // MARK: - Dates

    enum DayPart { case morning, evening }

    private func parseDate(_ text: inout String, today: Date) -> (day: Date, part: DayPart?)? {
        let cal = calendar
        let year = cal.component(.year, from: today)

        // 2026-10-16, 2026/10/16, 2026年10月16日
        if let m = Regex.first(#"(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号號]?"#, in: text),
           let y = m.int(1), let mo = m.int(2), let d = m.int(3),
           let date = cal.date(from: DateComponents(year: y, month: mo, day: d)) {
            text.replaceSubrange(m.range, with: " ")
            return (date, nil)
        }

        // 10月16日, 10月16号, 十月十六日
        if let m = Regex.first("(\(Regex.anyNum))\\s*月\\s*(\(Regex.anyNum))\\s*[日号號]", in: text),
           let mo = ChineseNumber.parse(m[1]), let d = ChineseNumber.parse(m[2]),
           let date = nearestFuture(month: mo, day: d, year: year, today: today) {
            text.replaceSubrange(m.range, with: " ")
            return (date, nil)
        }

        // 10/16
        if let m = Regex.first(#"(?<![\d:/])(\d{1,2})/(\d{1,2})(?![\d/])"#, in: text),
           let mo = m.int(1), let d = m.int(2), (1...12).contains(mo), (1...31).contains(d),
           let date = nearestFuture(month: mo, day: d, year: year, today: today) {
            text.replaceSubrange(m.range, with: " ")
            return (date, nil)
        }

        // Relative words
        let words: [(String, Int, DayPart?)] = [
            ("大后天", 3, nil), ("后天", 2, nil),
            ("明早", 1, .morning), ("明晨", 1, .morning), ("明晚", 1, .evening),
            ("明天", 1, nil), ("明日", 1, nil),
            ("今早", 0, .morning), ("今晨", 0, .morning), ("今晚", 0, .evening),
            ("今天", 0, nil), ("今日", 0, nil),
            ("昨天", -1, nil),
            ("tomorrow", 1, nil), ("tmr", 1, nil), ("tonight", 0, .evening), ("today", 0, nil),
        ]
        let alternation = words.map { NSRegularExpression.escapedPattern(for: $0.0) }.joined(separator: "|")
        if let m = Regex.first("(?<![a-z])(\(alternation))(?![a-z])", in: text),
           let word = m[1]?.lowercased(),
           let entry = words.first(where: { $0.0 == word }),
           let date = cal.date(byAdding: .day, value: entry.1, to: today) {
            text.replaceSubrange(m.range, with: " ")
            return (date, entry.2)
        }

        // 3天后
        if let m = Regex.first("(\(Regex.anyNum))\\s*天[以之]?后", in: text),
           let n = ChineseNumber.parse(m[1]),
           let date = cal.date(byAdding: .day, value: n, to: today) {
            text.replaceSubrange(m.range, with: " ")
            return (date, nil)
        }

        // 周三, 下周三, 本周日, 星期五, 礼拜天
        if let m = Regex.first(#"(下下个?|下个?|这个?|本|上个?)?\s*(?:周|星期|礼拜|週)\s*([一二三四五六日天1-7])"#, in: text),
           let target = Self.weekdayIndex(m[2] ?? "") {
            text.replaceSubrange(m.range, with: " ")
            return (weekdayDate(target, prefix: m[1], today: today), nil)
        }

        // next fri, monday
        if let m = Regex.first(#"(?<![a-z])(next\s+|this\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?(?![a-z])"#, in: text),
           let target = Self.englishWeekday(m[2] ?? "") {
            text.replaceSubrange(m.range, with: " ")
            let prefix = m[1]?.trimmingCharacters(in: .whitespaces).lowercased()
            return (weekdayDate(target, prefix: prefix == "next" ? "下" : (prefix == "this" ? "本" : nil), today: today), nil)
        }

        // 16号 / 16日 (not "12号床", "一日三餐")
        let dayOfMonth = [
            "(?<![\\d月/])(\\d{1,2}|\(Regex.num))\\s*[号號](?![床房楼樓病诊診室线線窗口])",
            "(?<![\\d月/])(\\d{1,2})\\s*日(?![程历曆])",
        ]
        for pattern in dayOfMonth {
            if let m = Regex.first(pattern, in: text),
               let d = ChineseNumber.parse(m[1]), (1...31).contains(d) {
                let month = cal.component(.month, from: today)
                if let date = nearestFuture(month: month, day: d, year: year, today: today, rollMonth: true) {
                    text.replaceSubrange(m.range, with: " ")
                    return (date, nil)
                }
            }
        }
        return nil
    }

    /// The given month/day this year, or next year/month if it already passed.
    private func nearestFuture(month: Int, day: Int, year: Int, today: Date, rollMonth: Bool = false) -> Date? {
        guard let date = calendar.date(from: DateComponents(year: year, month: month, day: day)),
              calendar.component(.day, from: date) == day else { return nil }
        if date >= today { return date }
        if rollMonth {
            return calendar.date(byAdding: .month, value: 1, to: date)
        }
        return calendar.date(byAdding: .year, value: 1, to: date)
    }

    private func weekdayDate(_ target: Int, prefix: String?, today: Date) -> Date {
        let current = calendar.isoWeekday(today)
        let delta: Int
        switch prefix ?? "" {
        case "本", "这", "这个": delta = target - current
        case "下", "下个": delta = 7 - current + target
        case "下下", "下下个": delta = 14 - current + target
        case "上", "上个": delta = target - current - 7
        default: delta = (target - current + 7) % 7
        }
        return calendar.date(byAdding: .day, value: delta, to: today) ?? today
    }

    static func weekdayIndex(_ s: String) -> Int? {
        switch s {
        case "一", "1": return 1
        case "二", "2": return 2
        case "三", "3": return 3
        case "四", "4": return 4
        case "五", "5": return 5
        case "六", "6": return 6
        case "日", "天", "7": return 7
        default: return nil
        }
    }

    static func englishWeekday(_ s: String) -> Int? {
        switch s.lowercased().prefix(3) {
        case "mon": return 1
        case "tue": return 2
        case "wed": return 3
        case "thu": return 4
        case "fri": return 5
        case "sat": return 6
        case "sun": return 7
        default: return nil
        }
    }

    // MARK: - Durations

    private func parseDuration(_ text: inout String) -> Int? {
        // 一个半小时 / 1个半小时
        if let m = Regex.first("(\(Regex.anyNum))\\s*个半\\s*(?:小时|钟头|鐘頭)", in: text),
           let h = ChineseNumber.parse(m[1]) {
            text.replaceSubrange(m.range, with: " ")
            return h * 60 + 30
        }
        // 半小时 / 半个小时 / 半个钟头
        if let m = Regex.first(#"半\s*个?\s*(?:小时|钟头|鐘頭)"#, in: text) {
            text.replaceSubrange(m.range, with: " ")
            return 30
        }
        // 1.5小时, 2个小时, 1h, 1小时30分钟, 1h30m
        let hourPattern = "(\\d+(?:\\.\\d+)?|\(Regex.num))\\s*个?\\s*(?:小时|钟头|鐘頭|hours?|hrs?|h)(?![a-z])"
            + "(?:\\s*(\\d+|\(Regex.num))\\s*(?:分钟|分鐘|分|minutes?|mins?|m)(?![a-z]))?"
        if let m = Regex.first(hourPattern, in: text),
           let raw = m[1] {
            let hours = Double(raw) ?? ChineseNumber.parse(raw).map(Double.init)
            if let hours {
                text.replaceSubrange(m.range, with: " ")
                let extra = m[2].flatMap { Int($0) ?? ChineseNumber.parse($0) } ?? 0
                return Int((hours * 60).rounded()) + extra
            }
        }
        // 45分钟, 90min, 30m (a bare "分" is left alone: "3点15分" is a time)
        if let m = Regex.first("(\\d+|\(Regex.num))\\s*(?:分钟|分鐘|minutes?|mins?|m)(?![a-z])", in: text),
           let minutes = m[1].flatMap({ Int($0) ?? ChineseNumber.parse($0) }), minutes > 0 {
            text.replaceSubrange(m.range, with: " ")
            return minutes
        }
        return nil
    }

    // MARK: - Times

    /// Groups per time: 1 period, 2 hour, 3 colon, 4 colon minutes, 5 点,
    /// 6 Chinese minute word, 7 Chinese minute number, 8 am/pm.
    private static let groupsPerTime = 8
    private static let timePattern =
        "(?:(上午|早上|早晨|清晨|中午|下午|午后|傍晚|晚上|夜里|夜间|深夜|凌晨)\\s*)?"
        + "(\\d{1,2}|\(Regex.num))"
        + "(?:\\s*([:：])\\s*(\\d{2})|\\s*([点點])(?:\\s*(半|一刻|三刻|(\\d{1,2}|\(Regex.num))\\s*分?))?)?"
        + "(?:\\s*(am|pm|a\\.m\\.|p\\.m\\.)(?![a-z]))?"

    private struct ClockTime {
        var hour: Int
        var minute: Int
        var period: String?
        var ampm: String?
        var isColon: Bool
        /// A colon, 点 or am/pm is present (a bare number is not a time).
        var hasMarker: Bool
        /// Written in 24-hour form ("08:00", "17点"), so never shifted by 12 h.
        var is24Hour: Bool
    }

    private func clockTime(_ m: Regex.Match, offset: Int) -> ClockTime? {
        guard let hourText = m[offset + 2], let hour = ChineseNumber.parse(hourText) else { return nil }
        let colonMinute = m[offset + 4]
        let cnWord = m[offset + 6]
        let cnNumber = m[offset + 7]
        let ampm = m[offset + 8]?.lowercased().replacingOccurrences(of: ".", with: "")

        var minute = 0
        if let colonMinute { minute = Int(colonMinute) ?? 0 }
        else if let cnNumber { minute = ChineseNumber.parse(cnNumber) ?? 0 }
        else if cnWord == "半" { minute = 30 }
        else if cnWord == "一刻" { minute = 15 }
        else if cnWord == "三刻" { minute = 45 }

        guard (0...24).contains(hour), (0...59).contains(minute) else { return nil }
        // "一点" alone usually means "a little" (早一点到), not 1 o'clock.
        if hourText == "一", m[offset + 1] == nil, cnWord == nil, cnNumber == nil, ampm == nil {
            return nil
        }
        return ClockTime(hour: hour, minute: minute, period: m[offset + 1], ampm: ampm,
                         isColon: colonMinute != nil,
                         hasMarker: colonMinute != nil || m[offset + 5] != nil || ampm != nil,
                         is24Hour: hour >= 13 || (hourText.count == 2 && hourText.hasPrefix("0")))
    }

    /// Minutes after midnight, applying 上午/下午/pm and the day-part hint.
    /// With `guessAfternoon`, a bare 1–6 o'clock means the afternoon ("3点开会" → 15:00).
    private func resolve(_ t: ClockTime, hint: DayPart?, guessAfternoon: Bool) -> Int {
        var h = t.hour
        if let ampm = t.ampm {
            if ampm == "pm", h < 12 { h += 12 }
            if ampm == "am", h == 12 { h = 0 }
        } else if let period = t.period {
            switch period {
            case "下午", "午后", "傍晚", "晚上", "夜里", "夜间", "深夜":
                if h < 12 { h += 12 } else if h == 12 { h = 24 }
            case "中午":
                if h < 6 { h += 12 }
            case "凌晨":
                if h == 12 { h = 0 }
            default:
                break
            }
        } else if hint == .evening, h < 12 {
            h += 12
        } else if guessAfternoon, hint == nil, (1...6).contains(h), !t.is24Hour {
            h += 12
        }
        return h * 60 + t.minute
    }

    private func parseTimeRange(_ text: inout String, hint: DayPart?) -> (Int, Int)? {
        let pattern = Self.timePattern + "\\s*(?:-|–|—|~|～|〜|到|至|to)\\s*" + Self.timePattern
        for m in Regex.all(pattern, in: text) {
            guard var a = clockTime(m, offset: 0), let b = clockTime(m, offset: Self.groupsPerTime),
                  a.hasMarker || b.hasMarker else { continue }
            // "3-5pm": the first time borrows the second's am/pm
            if a.ampm == nil, a.period == nil, let ampm = b.ampm { a.ampm = ampm }

            var start = resolve(a, hint: hint, guessAfternoon: true)
            let end: Int
            if b.ampm != nil || b.period != nil || b.is24Hour {
                let explicit = resolve(b, hint: hint, guessAfternoon: false)
                // "6:00-14:00" is a morning start, not 18:00
                let plainStart = resolve(a, hint: hint, guessAfternoon: false)
                if plainStart < explicit, start >= explicit { start = plainStart }
                end = explicit > start ? explicit : explicit + 24 * 60
            } else if hint == .evening {
                let e = resolve(b, hint: hint, guessAfternoon: false)
                end = e > start ? e : e + 24 * 60
            } else {
                // Earliest reading after the start: "3点-5点" → 17:00, "22:00-6:00" → next day 06:00
                let raw = b.hour * 60 + b.minute
                var candidates = [raw]
                if b.hour < 12 { candidates.append(raw + 12 * 60) }
                candidates.append(raw + 24 * 60)
                end = candidates.first(where: { $0 > start }) ?? raw + 24 * 60
            }
            text.replaceSubrange(m.range, with: " ")
            return (start, end)
        }
        return nil
    }

    private func parseSingleTime(_ text: inout String, hint: DayPart?) -> Int? {
        for m in Regex.all(Self.timePattern, in: text) {
            guard let t = clockTime(m, offset: 0), t.hasMarker else { continue }
            text.replaceSubrange(m.range, with: " ")
            return resolve(t, hint: hint, guessAfternoon: true)
        }
        return nil
    }

    // MARK: - Title

    private func cleanTitle(_ text: String) -> String {
        let collapsed = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let junk = CharacterSet(charactersIn: ",，、;；:：-–—~～.。").union(.whitespaces)
        return collapsed.trimmingCharacters(in: junk)
    }

    private func matchShift(_ title: String) -> String? {
        let t = title.lowercased()
        guard !t.isEmpty else { return nil }
        return shiftNames.first { $0.lowercased() == t }
    }
}

// MARK: - Chinese numerals

public enum ChineseNumber {
    /// "12" → 12, "十二" → 12, "二十三" → 23, "两" → 2, "十" → 10.
    public static func parse(_ text: String?) -> Int? {
        guard let text, !text.isEmpty else { return nil }
        if let n = Int(text) { return n }
        let digits: [Character: Int] = ["零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "兩": 2, "三": 3,
                                        "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9]
        var total = 0
        var current = 0
        var sawTen = false
        for ch in text {
            if let d = digits[ch] {
                current = d
            } else if ch == "十" {
                total += (current == 0 ? 1 : current) * 10
                current = 0
                sawTen = true
            } else {
                return nil
            }
        }
        let value = total + current
        return (value > 0 || sawTen || text.contains(where: { $0 == "零" || $0 == "〇" })) ? value : nil
    }
}

// MARK: - Small NSRegularExpression wrapper

enum Regex {
    /// Chinese numerals 零…九十九 (digits are matched separately where allowed).
    static let num = "[零〇一二两兩三四五六七八九十]{1,3}"
    /// Arabic digits or Chinese numerals.
    static let anyNum = "\\d{1,2}|[零〇一二两兩三四五六七八九十]{1,3}"

    struct Match {
        let range: Range<String.Index>
        let groups: [String?]

        subscript(i: Int) -> String? { i < groups.count ? groups[i] : nil }
        func int(_ i: Int) -> Int? { self[i].flatMap { Int($0) } }

    }

    private static var cache: [String: NSRegularExpression] = [:]
    private static let lock = NSLock()

    private static func compile(_ pattern: String) -> NSRegularExpression? {
        lock.lock(); defer { lock.unlock() }
        if let r = cache[pattern] { return r }
        let r = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
        cache[pattern] = r
        return r
    }

    static func all(_ pattern: String, in text: String) -> [Match] {
        guard let regex = compile(pattern) else { return [] }
        let ns = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.matches(in: text, options: [], range: ns).compactMap { r in
            guard let range = Range(r.range, in: text), !range.isEmpty else { return nil }
            let groups: [String?] = (0..<r.numberOfRanges).map { i in
                let gr = r.range(at: i)
                guard gr.location != NSNotFound, let rr = Range(gr, in: text) else { return nil }
                return String(text[rr])
            }
            return Match(range: range, groups: groups)
        }
    }

    static func first(_ pattern: String, in text: String) -> Match? {
        all(pattern, in: text).first
    }
}
