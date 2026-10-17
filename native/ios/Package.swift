// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AsterHalo",
    platforms: [.iOS(.v16)],
    products: [.library(name: "AsterHalo", targets: ["AsterHalo"])],
    targets: [.target(name: "AsterHalo")]
)
