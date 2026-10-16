import SwiftUI

@main
struct OneGlanceApp: App {
    @StateObject private var prefs: Preferences
    @StateObject private var store: CalendarStore
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let prefs = Preferences()
        _prefs = StateObject(wrappedValue: prefs)
        _store = StateObject(wrappedValue: CalendarStore(prefs: prefs))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(prefs)
                .onChange(of: scenePhase) { _, phase in
                    // Catch changes made while we were in the background
                    if phase == .active { store.refreshFromSystem() }
                }
        }
    }
}
