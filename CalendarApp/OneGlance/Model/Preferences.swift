import SwiftUI
import GlanceCore

/// User settings and shift templates, stored in UserDefaults on this device.
@MainActor
final class Preferences: ObservableObject {
    private let defaults: UserDefaults

    /// Calendars / reminder lists the user switched off.
    @Published var hiddenCalendarIDs: Set<String> { didSet { save(Array(hiddenCalendarIDs), "hiddenCalendarIDs") } }
    @Published var defaultEventCalendarID: String? { didSet { save(defaultEventCalendarID, "defaultEventCalendarID") } }
    @Published var defaultReminderListID: String? { didSet { save(defaultReminderListID, "defaultReminderListID") } }
    @Published var shiftCalendarID: String? { didSet { save(shiftCalendarID, "shiftCalendarID") } }
    @Published var shiftTemplates: [ShiftTemplate] { didSet { saveTemplates() } }

    /// Working hours per day that count as "full" on the heat map.
    @Published var dayCapacityHours: Double { didSet { save(dayCapacityHours, "dayCapacityHours") } }
    @Published var defaultEventMinutes: Int { didSet { save(defaultEventMinutes, "defaultEventMinutes") } }
    @Published var defaultTaskMinutes: Int { didSet { save(defaultTaskMinutes, "defaultTaskMinutes") } }
    /// Rest between two shifts shorter than this is flagged.
    @Published var minimumRestHours: Double { didSet { save(minimumRestHours, "minimumRestHours") } }
    @Published var showCompleted: Bool { didSet { save(showCompleted, "showCompleted") } }
    @Published var hourHeight: Double { didSet { save(hourHeight, "hourHeight") } }
    @Published var dayStyle: DayStyle { didSet { save(dayStyle.rawValue, "dayStyle") } }

    enum DayStyle: String { case timeline, list }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        hiddenCalendarIDs = Set(defaults.stringArray(forKey: "hiddenCalendarIDs") ?? [])
        defaultEventCalendarID = defaults.string(forKey: "defaultEventCalendarID")
        defaultReminderListID = defaults.string(forKey: "defaultReminderListID")
        shiftCalendarID = defaults.string(forKey: "shiftCalendarID")
        if let data = defaults.data(forKey: "shiftTemplates"),
           let decoded = try? JSONDecoder().decode([ShiftTemplate].self, from: data) {
            shiftTemplates = decoded
        } else {
            shiftTemplates = ShiftTemplate.defaults
        }
        dayCapacityHours = defaults.object(forKey: "dayCapacityHours") as? Double ?? 8
        defaultEventMinutes = defaults.object(forKey: "defaultEventMinutes") as? Int ?? 60
        defaultTaskMinutes = defaults.object(forKey: "defaultTaskMinutes") as? Int ?? 30
        minimumRestHours = defaults.object(forKey: "minimumRestHours") as? Double ?? 11
        showCompleted = defaults.object(forKey: "showCompleted") as? Bool ?? true
        hourHeight = defaults.object(forKey: "hourHeight") as? Double ?? 56
        dayStyle = DayStyle(rawValue: defaults.string(forKey: "dayStyle") ?? "") ?? .timeline
    }

    func template(id: UUID?) -> ShiftTemplate? {
        guard let id else { return nil }
        return shiftTemplates.first { $0.id == id }
    }

    func template(named name: String) -> ShiftTemplate? {
        let n = name.trimmingCharacters(in: .whitespaces).lowercased()
        return shiftTemplates.first { $0.name.lowercased() == n || $0.shortName.lowercased() == n }
    }

    private func save(_ value: Any?, _ key: String) {
        if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }

    private func saveTemplates() {
        if let data = try? JSONEncoder().encode(shiftTemplates) {
            defaults.set(data, forKey: "shiftTemplates")
        }
    }
}
