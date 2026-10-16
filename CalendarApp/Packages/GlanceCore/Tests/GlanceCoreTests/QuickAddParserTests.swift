import XCTest
@testable import GlanceCore

final class QuickAddParserTests: XCTestCase {
    var cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(secondsFromGMT: 0)!
        c.firstWeekday = 2
        return c
    }()

    /// Friday 2026-10-16 09:00
    lazy var now = date(2026, 10, 16, 9, 0)

    func date(_ y: Int, _ mo: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0) -> Date {
        cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
    }

    func parse(_ text: String, override: QuickAddParser.Override = .automatic,
               shifts: [String] = []) -> QuickAddParser.Result {
        QuickAddParser(calendar: cal, defaultEventMinutes: 60, shiftNames: shifts)
            .parse(text, now: now, defaultDay: now, override: override)
    }

    func testTomorrowAfternoonWithDuration() {
        let r = parse("明天下午3点 开会 1小时")
        XCTAssertEqual(r.kind, .event)
        XCTAssertEqual(r.title, "开会")
        XCTAssertEqual(r.start, date(2026, 10, 17, 15, 0))
        XCTAssertEqual(r.end, date(2026, 10, 17, 16, 0))
        XCTAssertEqual(r.durationMinutes, 60)
    }

    func testColonRange() {
        let r = parse("周五 10:30-12:00 门诊")
        XCTAssertEqual(r.kind, .event)
        XCTAssertEqual(r.title, "门诊")
        XCTAssertEqual(r.start, date(2026, 10, 16, 10, 30))
        XCTAssertEqual(r.end, date(2026, 10, 16, 12, 0))
    }

    func testOvernightRange() {
        let r = parse("下周一 20:00-08:00 夜班支援")
        XCTAssertEqual(r.start, date(2026, 10, 19, 20, 0))
        XCTAssertEqual(r.end, date(2026, 10, 20, 8, 0))
        let r2 = parse("22:00-6:00 急诊")
        XCTAssertEqual(r2.start, date(2026, 10, 16, 22, 0))
        XCTAssertEqual(r2.end, date(2026, 10, 17, 6, 0))
    }

    func testChineseRangeInheritsAfternoon() {
        let r = parse("下午3点到5点 写病历")
        XCTAssertEqual(r.start, date(2026, 10, 16, 15, 0))
        XCTAssertEqual(r.end, date(2026, 10, 16, 17, 0))
        let r2 = parse("3点-5点 讨论")
        XCTAssertEqual(r2.start, date(2026, 10, 16, 15, 0))
        XCTAssertEqual(r2.end, date(2026, 10, 16, 17, 0))
        let r3 = parse("11点-1点 午会")
        XCTAssertEqual(r3.start, date(2026, 10, 16, 11, 0))
        XCTAssertEqual(r3.end, date(2026, 10, 16, 13, 0))
    }

    func testMorningRangeIsNotShifted() {
        let r = parse("6:00-14:00 早班")
        XCTAssertEqual(r.start, date(2026, 10, 16, 6, 0))
        XCTAssertEqual(r.end, date(2026, 10, 16, 14, 0))
    }

    func testEnglishAmPm() {
        let r = parse("3-5pm review")
        XCTAssertEqual(r.start, date(2026, 10, 16, 15, 0))
        XCTAssertEqual(r.end, date(2026, 10, 16, 17, 0))
        let r2 = parse("tomorrow 9:30am standup 15m")
        XCTAssertEqual(r2.start, date(2026, 10, 17, 9, 30))
        XCTAssertEqual(r2.end, date(2026, 10, 17, 9, 45))
        XCTAssertEqual(r2.title, "standup")
    }

    func testHalfAndQuarter() {
        XCTAssertEqual(parse("8点半 查房").start, date(2026, 10, 16, 8, 30))
        XCTAssertEqual(parse("晚上七点一刻 跑步").start, date(2026, 10, 16, 19, 15))
        XCTAssertEqual(parse("十点三刻 电话").start, date(2026, 10, 16, 10, 45))
        XCTAssertEqual(parse("下午2点15分 会诊").start, date(2026, 10, 16, 14, 15))
    }

    func testBareHourGuessesAfternoon() {
        XCTAssertEqual(parse("3点开会").start, date(2026, 10, 16, 15, 0))
        XCTAssertEqual(parse("9点开会").start, date(2026, 10, 16, 9, 0))
        XCTAssertEqual(parse("06:30 起床").start, date(2026, 10, 16, 6, 30))
        XCTAssertEqual(parse("明早6点 起床").start, date(2026, 10, 17, 6, 0))
        XCTAssertEqual(parse("今晚8点 看书").start, date(2026, 10, 16, 20, 0))
    }

    func testReminderWithoutTime() {
        let r = parse("买药")
        XCTAssertEqual(r.kind, .reminder)
        XCTAssertEqual(r.title, "买药")
        XCTAssertEqual(r.day, date(2026, 10, 16))
        XCTAssertNil(r.start)
        XCTAssertFalse(r.hasExplicitDate)
    }

    func testReminderPrefixKeepsTime() {
        let r = parse("待办：明天下午3点 交报告 !!")
        XCTAssertEqual(r.kind, .reminder)
        XCTAssertEqual(r.title, "交报告")
        XCTAssertEqual(r.start, date(2026, 10, 17, 15, 0))
        XCTAssertNil(r.end)
        XCTAssertEqual(r.priority, 5)
    }

    func testDurationOnlyIsTaskEstimate() {
        let r = parse("写论文 2小时")
        XCTAssertEqual(r.kind, .reminder)
        XCTAssertEqual(r.durationMinutes, 120)
        XCTAssertEqual(r.title, "写论文")
        XCTAssertEqual(parse("复习 一个半小时").durationMinutes, 90)
        XCTAssertEqual(parse("复习 半小时").durationMinutes, 30)
        XCTAssertEqual(parse("复习 1.5h").durationMinutes, 90)
        XCTAssertEqual(parse("复习 1小时30分钟").durationMinutes, 90)
        XCTAssertEqual(parse("复习 45分钟").durationMinutes, 45)
    }

    func testCalendarHintAndPriority() {
        let r = parse("周三 9点 组会 #工作 !!!")
        XCTAssertEqual(r.calendarHint, "工作")
        XCTAssertEqual(r.priority, 1)
        XCTAssertEqual(r.title, "组会")
        XCTAssertEqual(r.start, date(2026, 10, 21, 9, 0))
    }

    func testWeekdays() {
        // Today is Friday 10/16
        XCTAssertEqual(parse("周五 a").day, date(2026, 10, 16))
        XCTAssertEqual(parse("周一 a").day, date(2026, 10, 19))
        XCTAssertEqual(parse("下周三 a").day, date(2026, 10, 21))
        XCTAssertEqual(parse("本周三 a").day, date(2026, 10, 14))
        XCTAssertEqual(parse("下下周一 a").day, date(2026, 10, 26))
        XCTAssertEqual(parse("星期天 a").day, date(2026, 10, 18))
        XCTAssertEqual(parse("礼拜六 a").day, date(2026, 10, 17))
        XCTAssertEqual(parse("next mon a").day, date(2026, 10, 19))
        XCTAssertEqual(parse("wednesday a").day, date(2026, 10, 21))
    }

    func testAbsoluteDates() {
        XCTAssertEqual(parse("10月20日 体检").day, date(2026, 10, 20))
        XCTAssertEqual(parse("十月二十号 体检").day, date(2026, 10, 20))
        XCTAssertEqual(parse("1/5 年假").day, date(2027, 1, 5))
        XCTAssertEqual(parse("2026-12-24 平安夜").day, date(2026, 12, 24))
        XCTAssertEqual(parse("20号 交房租").day, date(2026, 10, 20))
        XCTAssertEqual(parse("3号 交房租").day, date(2026, 11, 3))
        XCTAssertEqual(parse("后天 a").day, date(2026, 10, 18))
        XCTAssertEqual(parse("大后天 a").day, date(2026, 10, 19))
        XCTAssertEqual(parse("3天后 复诊").day, date(2026, 10, 19))
    }

    func testBedNumbersAreNotDates() {
        let r = parse("查12号床 病人")
        XCTAssertFalse(r.hasExplicitDate)
        XCTAssertEqual(r.title, "查12号床 病人")
    }

    func testYiDianIsNotATime() {
        let r = parse("早一点到")
        XCTAssertNil(r.start)
        XCTAssertEqual(r.kind, .reminder)
    }

    func testAllDay() {
        let r = parse("明天 全天 学术会议")
        XCTAssertEqual(r.kind, .allDayEvent)
        XCTAssertEqual(r.start, date(2026, 10, 17))
        XCTAssertEqual(r.end, date(2026, 10, 18))
        XCTAssertEqual(r.title, "学术会议")
    }

    func testShiftByName() {
        let r = parse("周六 夜班", shifts: ["白班", "夜班"])
        XCTAssertEqual(r.kind, .shift)
        XCTAssertEqual(r.shiftName, "夜班")
        XCTAssertEqual(r.day, date(2026, 10, 17))
        // With a time it stays an ordinary event
        XCTAssertEqual(parse("周六 8点 夜班", shifts: ["夜班"]).kind, .event)
    }

    func testOverrides() {
        XCTAssertEqual(parse("3点 交报告", override: .reminder).kind, .reminder)
        let r = parse("体检", override: .event)
        XCTAssertEqual(r.kind, .allDayEvent)
    }

    func testMidnightEvening() {
        let r = parse("晚上12点 发药")
        XCTAssertEqual(r.start, date(2026, 10, 17, 0, 0))
    }

    func testChineseNumbers() {
        XCTAssertEqual(ChineseNumber.parse("十"), 10)
        XCTAssertEqual(ChineseNumber.parse("十二"), 12)
        XCTAssertEqual(ChineseNumber.parse("二十三"), 23)
        XCTAssertEqual(ChineseNumber.parse("两"), 2)
        XCTAssertEqual(ChineseNumber.parse("零"), 0)
        XCTAssertNil(ChineseNumber.parse("个"))
    }
}
