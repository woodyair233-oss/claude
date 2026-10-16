import XCTest
@testable import GlanceCore

final class TimelineLayoutTests: XCTestCase {
    typealias Item = TimelineLayout.Item

    func testNonOverlappingUseFullWidth() {
        let slots = TimelineLayout.layout([Item(id: "a", start: 60, end: 120), Item(id: "b", start: 120, end: 180)])
        XCTAssertEqual(slots["a"], .init(column: 0, columnCount: 1, span: 1))
        XCTAssertEqual(slots["b"], .init(column: 0, columnCount: 1, span: 1))
    }

    func testOverlapSplitsColumns() {
        let slots = TimelineLayout.layout([
            Item(id: "a", start: 60, end: 180),
            Item(id: "b", start: 90, end: 120),
            Item(id: "c", start: 130, end: 170),
        ])
        XCTAssertEqual(slots["a"]?.column, 0)
        XCTAssertEqual(slots["b"]?.column, 1)
        XCTAssertEqual(slots["c"]?.column, 1)
        XCTAssertEqual(slots["a"]?.columnCount, 2)
    }

    func testSpanExpandsIntoFreeColumns() {
        let slots = TimelineLayout.layout([
            Item(id: "a", start: 0, end: 60),
            Item(id: "b", start: 0, end: 30),
            Item(id: "c", start: 0, end: 30),
            Item(id: "d", start: 40, end: 60),
        ])
        XCTAssertEqual(slots["a"]?.columnCount, 3)
        // d sits in column 1 and can stretch over column 2 (c ended at 30)
        XCTAssertEqual(slots["d"]?.column, 1)
        XCTAssertEqual(slots["d"]?.span, 2)
    }

    func testTinyItemsGetMinimumHeightForOverlap() {
        let slots = TimelineLayout.layout([Item(id: "a", start: 0, end: 5), Item(id: "b", start: 10, end: 15)],
                                          minimumLength: 20)
        XCTAssertEqual(slots["a"]?.columnCount, 2)
    }

    func testBusyMinutesMergesOverlaps() {
        XCTAssertEqual(DayLoad.busyMinutes([(60, 120), (90, 150), (300, 360)]), 150)
        XCTAssertEqual(DayLoad.busyMinutes([(-60, 30), (1400, 1600)]), 70)
        XCTAssertEqual(DayLoad.level(busyMinutes: 0, capacityMinutes: 480), 0)
        XCTAssertEqual(DayLoad.level(busyMinutes: 60, capacityMinutes: 480), 1)
        XCTAssertEqual(DayLoad.level(busyMinutes: 480, capacityMinutes: 480), 4)
    }

    func testFreeGaps() {
        let gaps = FreeTime.gaps([(480, 540), (600, 660), (650, 700), (705, 720)], minimumGap: 15)
        XCTAssertEqual(gaps.count, 1)
        XCTAssertEqual(gaps.first?.start, 540)
        XCTAssertEqual(gaps.first?.end, 600)
    }
}

final class ShiftTests: XCTestCase {
    var cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(secondsFromGMT: 0)!
        c.firstWeekday = 2
        return c
    }()

    func date(_ y: Int, _ mo: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0) -> Date {
        cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
    }

    func testNightShiftCrossesMidnight() {
        let night = ShiftTemplate.defaults[1]
        let i = night.interval(on: date(2026, 10, 16), calendar: cal)
        XCTAssertEqual(i.start, date(2026, 10, 16, 20))
        XCTAssertEqual(i.end, date(2026, 10, 17, 8))
        XCTAssertEqual(night.timeText, "20:00–次日08:00")
        XCTAssertEqual(ShiftTemplate.defaults[0].timeText, "08:00–17:00")
        XCTAssertEqual(ShiftTemplate.defaults[3].timeText, "全天")
    }

    func testMarkerRoundTrip() {
        let id = ShiftTemplate.defaults[2].id
        XCTAssertEqual(ShiftMarker.templateID(from: ShiftMarker.url(for: id)), id)
        XCTAssertNil(ShiftMarker.templateID(from: URL(string: "https://example.com/shift/x")))
        XCTAssertNil(ShiftMarker.templateID(from: nil))
    }

    func testRestBefore() {
        let shifts = [
            ShiftAnalysis.Occurrence(templateID: nil, start: date(2026, 10, 1, 20), end: date(2026, 10, 2, 8), isAllDay: false),
            ShiftAnalysis.Occurrence(templateID: nil, start: date(2026, 10, 2), end: date(2026, 10, 3), isAllDay: true),
            ShiftAnalysis.Occurrence(templateID: nil, start: date(2026, 10, 2, 16), end: date(2026, 10, 2, 23), isAllDay: false),
        ]
        let rest = ShiftAnalysis.restBefore(shifts)
        XCTAssertEqual(rest.count, 3)
        XCTAssertNil(rest[0])
        XCTAssertNil(rest[1])
        XCTAssertEqual(rest[2], 8)
    }

    func testSummary() {
        let day = ShiftTemplate.defaults[0]
        let off = ShiftTemplate.defaults[3]
        let shifts = [
            ShiftAnalysis.Occurrence(templateID: day.id, start: date(2026, 10, 1, 8), end: date(2026, 10, 1, 17), isAllDay: false),
            ShiftAnalysis.Occurrence(templateID: day.id, start: date(2026, 10, 2, 8), end: date(2026, 10, 2, 17), isAllDay: false),
            ShiftAnalysis.Occurrence(templateID: off.id, start: date(2026, 10, 3), end: date(2026, 10, 4), isAllDay: true),
            ShiftAnalysis.Occurrence(templateID: day.id, start: date(2026, 11, 1, 8), end: date(2026, 11, 1, 17), isAllDay: false),
        ]
        let s = ShiftAnalysis.summary(shifts, in: DateInterval(start: date(2026, 10, 1), end: date(2026, 11, 1)))
        XCTAssertEqual(s.countByTemplate[day.id], 2)
        XCTAssertEqual(s.countByTemplate[off.id], 1)
        XCTAssertEqual(s.totalWorkMinutes, 18 * 60)
    }

    func testDayMath() {
        let fri = date(2026, 10, 16, 15, 30)
        XCTAssertEqual(cal.minuteOfDay(fri, relativeTo: fri), 930)
        XCTAssertEqual(cal.minuteOfDay(date(2026, 10, 17, 2), relativeTo: fri), 1440 + 120)
        XCTAssertEqual(cal.date(onDay: fri, minute: 1500), date(2026, 10, 17, 1))
        XCTAssertEqual(cal.weekDays(containing: fri).first, date(2026, 10, 12))
        XCTAssertEqual(cal.monthGrid(for: fri).first, date(2026, 9, 28))
        XCTAssertEqual(cal.monthGrid(for: fri).count, 42)
        XCTAssertEqual(cal.isoWeekday(fri), 5)
        XCTAssertEqual(Snap.minutes(52, step: 15), 45)
        XCTAssertEqual(Snap.minutes(53, step: 15), 60)
        XCTAssertEqual(DurationText.chinese(minutes: 90), "1小时30分")
    }

    func testHex() {
        let c = HexColor.rgb("#FF8000")!
        XCTAssertEqual(c.r, 1)
        XCTAssertEqual(HexColor.hex(r: c.r, g: c.g, b: c.b), "#FF8000")
        XCTAssertNil(HexColor.rgb("xyz"))
    }
}
