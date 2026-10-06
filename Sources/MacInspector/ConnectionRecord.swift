// SPDX-License-Identifier: MIT
import Foundation
import Darwin
import Security

final class ConnectionRecord {
  let session = UUID().uuidString
  private var file: URL?

  static func secret() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw InspectorError.invalid("Cannot generate the inspector session secret")
    }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  func publish(port: UInt16, token: String, title: String) throws {
    let manager = FileManager.default
    let directory = try manager.url(
      for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true
    ).appendingPathComponent("MacInspector/Connections", isDirectory: true)
    try manager.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    var info = stat()
    guard lstat(directory.path, &info) == 0, info.st_uid == getuid(),
      info.st_mode & S_IFMT == S_IFDIR, info.st_mode & 0o077 == 0
    else {
      throw InspectorError.invalid("Inspector discovery directory must be private to your user")
    }
    let url = directory.appendingPathComponent("\(ProcessInfo.processInfo.processIdentifier).json")
    let record: [String: Any] = [
      "version": 1, "pid": Int(ProcessInfo.processInfo.processIdentifier),
      "bundleId": Bundle.main.bundleIdentifier ?? "", "port": Int(port), "token": token,
      "session": session, "title": title,
    ]
    let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    try data.write(to: url, options: .atomic)
    try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    file = url
  }

  func remove() {
    guard let file,
      let data = try? Data(contentsOf: file),
      let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      record["session"] as? String == session
    else { return }
    try? FileManager.default.removeItem(at: file)
    self.file = nil
  }

  deinit { remove() }
}
