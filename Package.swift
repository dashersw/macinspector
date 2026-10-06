// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MacInspector", platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "MacInspector", targets: ["MacInspector"]),
        .executable(name: "NativeShowcase", targets: ["NativeShowcase"]),
        .executable(name: "SwiftUIShowcase", targets: ["SwiftUIShowcase"]),
        .executable(name: "AccessibilityBridge", targets: ["AccessibilityBridge"]),
        .executable(name: "SimulatorPointer", targets: ["SimulatorPointer"]),
    ],
    targets: [
        .target(name: "MacInspector"),
        .executableTarget(
            name: "NativeShowcase",
            dependencies: ["MacInspector"],
            path: "demo/macos",
            exclude: ["Info.plist", "Debug.entitlements"]
        ),
        .executableTarget(name: "AccessibilityBridge"),
        .executableTarget(
            name: "SwiftUIShowcase",
            dependencies: ["MacInspector"],
            path: "demo/swiftui",
            exclude: ["macos/Info.plist", "ios"]
        ),
        .executableTarget(name: "SimulatorPointer"),
        .testTarget(name: "MacInspectorTests", dependencies: ["MacInspector"]),
    ]
)
