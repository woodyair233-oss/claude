import XCTest

/// End-to-end smoke test in the Simulator: real EventKit, real gestures.
final class OneGlanceUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        grantAccessIfAsked()
        XCTAssertTrue(app.textFields["quickAdd"].waitForExistence(timeout: 15),
                      "Main screen did not appear\n\(app.debugDescription)")
    }

    /// CI grants access with `simctl privacy`; this handles the prompt if it still shows.
    private func grantAccessIfAsked() {
        let allow = app.buttons["允许访问日历与提醒事项"]
        guard allow.waitForExistence(timeout: 4) else { return }
        allow.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<2 {
            for label in ["Allow Full Access", "允许完全访问", "OK", "Allow", "好"] {
                let button = springboard.buttons[label]
                if button.waitForExistence(timeout: 4) {
                    button.tap()
                    break
                }
            }
        }
    }

    private func quickAdd(_ text: String) {
        let field = app.textFields["quickAdd"]
        field.tap()
        field.typeText(text)
        field.typeText("\n")
    }

    private func text(matching pattern: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", pattern)).firstMatch
    }

    func testPlanningFlow() throws {
        // Quick add an event for tomorrow 15:00–16:00
        quickAdd("tomorrow 3pm Standup 1h")
        XCTAssertTrue(app.staticTexts["已新增日程「Standup」"].waitForExistence(timeout: 5),
                      "No confirmation toast\n\(app.debugDescription)")

        // It shows on tomorrow's time grid
        app.buttons["下一页"].tap()
        let title = app.staticTexts["Standup"]
        XCTAssertTrue(title.waitForExistence(timeout: 5), "Event not on the timeline\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["15:00–16:00"].waitForExistence(timeout: 3),
                      "Unexpected time\n\(app.debugDescription)")

        // Long-press and drag it down about an hour
        let grab = title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        grab.press(forDuration: 0.6, thenDragTo: grab.withOffset(CGVector(dx: 0, dy: 56)),
                   withVelocity: .slow, thenHoldForDuration: 0.3)
        let moved = text(matching: "1[56]:[0-5][05]–1[67]:[0-5][05]")
        XCTAssertTrue(moved.waitForExistence(timeout: 5), "No time label after drag\n\(app.debugDescription)")
        XCTAssertFalse(app.staticTexts["15:00–16:00"].exists, "Drag did not move the event\n\(app.debugDescription)")
        let afterMove = moved.label
        print("After move: \(afterMove)")

        // Drag the bottom edge down about half an hour
        let block = app.staticTexts["Standup"]
        let top = block.frame.minY - 3
        let edge = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: block.frame.midX, dy: top + 50))
        edge.press(forDuration: 0.5, thenDragTo: edge.withOffset(CGVector(dx: 0, dy: 28)),
                   withVelocity: .slow, thenHoldForDuration: 0.3)
        let resized = text(matching: "1[56]:[0-5][05]–1[678]:[0-5][05]")
        XCTAssertTrue(resized.waitForExistence(timeout: 5))
        XCTAssertNotEqual(resized.label, afterMove, "Resize did not change the end time\n\(app.debugDescription)")
        print("After resize: \(resized.label)")

        // Week view
        app.buttons["周"].tap()
        XCTAssertTrue(app.staticTexts["全天"].waitForExistence(timeout: 3), "Week view missing\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["Standup"].exists, "Event missing in week view\n\(app.debugDescription)")

        // Month view: paint a night shift on the 20th with the shift brush
        app.buttons["月"].tap()
        let brush = app.buttons["排班"]
        XCTAssertTrue(brush.waitForExistence(timeout: 3), "Month view missing\n\(app.debugDescription)")
        brush.tap()
        let night = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "夜班")).firstMatch
        XCTAssertTrue(night.waitForExistence(timeout: 3), "Brush bar missing\n\(app.debugDescription)")
        night.tap()
        app.staticTexts["20"].firstMatch.tap()
        let summary = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "夜班 1")).firstMatch
        XCTAssertTrue(summary.waitForExistence(timeout: 5), "Shift not counted\n\(app.debugDescription)")
        brush.tap()

        // Back to the day (the 20th), list style, add a task
        app.buttons["日"].tap()
        let listToggle = app.buttons["切换到清单"]
        XCTAssertTrue(listToggle.waitForExistence(timeout: 3))
        listToggle.tap()
        quickAdd("todo Buy milk")
        XCTAssertTrue(app.staticTexts["已新增待办「Buy milk」"].waitForExistence(timeout: 5),
                      "No task toast\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["Buy milk"].waitForExistence(timeout: 5), "Task not listed\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["夜班"].exists, "Shift banner missing\n\(app.debugDescription)")
        print("UI flow finished")
    }
}
