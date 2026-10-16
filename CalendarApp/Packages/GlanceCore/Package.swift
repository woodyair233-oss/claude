// swift-tools-version:5.9
import PackageDescription

// Pure-Foundation logic shared by the app and the widget.
// It has no EventKit/SwiftUI dependency so it also builds and tests on Linux.
let package = Package(
    name: "GlanceCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "GlanceCore", targets: ["GlanceCore"]),
    ],
    targets: [
        .target(name: "GlanceCore"),
        .testTarget(name: "GlanceCoreTests", dependencies: ["GlanceCore"]),
    ]
)
