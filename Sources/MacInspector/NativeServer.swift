// SPDX-License-Identifier: MIT
import Foundation
import Network

/// Shared authenticated SDK transport. Platform adapters only implement UI operations.
final class NativeServer {
  let record = ConnectionRecord()
  private var listener: NWListener?
  private var connection: NWConnection?
  private var token = ""
  private var handler: ((String, [String: Any]) throws -> [String: Any])?
  private var onDisconnect: (() -> Void)?
  private(set) var connectionError: Error?
  var screenshot: ((@escaping (Result<[String: Any], Error>) -> Void) -> Void)?

  deinit {
    connection?.cancel()
    listener?.cancel()
  }

  func start(
    port: UInt16, token supplied: String?, title: String,
    handler: @escaping (String, [String: Any]) throws -> [String: Any],
    disconnected: @escaping () -> Void
  ) throws {
    precondition(Thread.isMainThread)
    guard listener == nil else { throw InspectorError.invalid("Inspector is already running") }
    token = try supplied ?? ConnectionRecord.secret()
    guard token.count >= 32 else {
      throw InspectorError.invalid("Inspector token must have at least 32 characters")
    }
    connectionError = nil
    self.handler = handler
    onDisconnect = disconnected
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(
      host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    listener.stateUpdateHandler = { [weak self, weak listener] state in
      DispatchQueue.main.async {
        guard let self, self.listener === listener else { return }
        if case .ready = state, let port = listener?.port {
          do { try self.record.publish(port: port.rawValue, token: self.token, title: title) } catch
          {
            self.connectionError = error
            self.stop()
          }
        } else if case .failed(let error) = state {
          self.connectionError = error
          self.stop()
        }
      }
    }
    listener.newConnectionHandler = { [weak self] client in
      DispatchQueue.main.async {
        guard let self, self.connection == nil else {
          client.cancel()
          return
        }
        self.connection = client
        client.stateUpdateHandler = { [weak self] state in
          if case .failed = state { DispatchQueue.main.async { self?.disconnected(client) } }
          if case .cancelled = state { DispatchQueue.main.async { self?.disconnected(client) } }
        }
        client.start(queue: .global(qos: .userInitiated))
        self.receive(client, buffer: Data())
      }
    }
    listener.start(queue: .global(qos: .userInitiated))
  }

  func stop() {
    precondition(Thread.isMainThread)
    connection?.cancel()
    listener?.cancel()
    connection = nil
    listener = nil
    handler = nil
    record.remove()
    onDisconnect?()
    onDisconnect = nil
  }

  private func disconnected(_ client: NWConnection) {
    guard connection === client else { return }
    connection = nil
    onDisconnect?()
  }

  private func receive(_ client: NWConnection, buffer: Data) {
    client.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
      [weak self] data, _, complete, error in
      guard let self else { return }
      var pending = buffer
      if let data { pending.append(data) }
      guard pending.count <= 1_048_576 else {
        client.cancel()
        return
      }
      while let newline = pending.firstIndex(of: 10) {
        let line = pending.prefix(upTo: newline)
        pending.removeSubrange(...newline)
        let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any]
        DispatchQueue.main.async {
          guard self.connection === client, let message, message["token"] as? String == self.token
          else {
            client.cancel()
            return
          }
          let id = message["id"] ?? 0
          do {
            guard let handler = self.handler else {
              throw InspectorError.invalid("Inspector closed")
            }
            let method = message["method"] as? String ?? ""
            if method == "screenshot", let screenshot = self.screenshot {
              screenshot { [weak self] result in
                DispatchQueue.main.async {
                  guard let self, self.connection === client else { return }
                  switch result {
                  case .success(let value): self.send(["id": id, "result": value], to: client)
                  case .failure(let error): self.send(["id": id, "error": error.localizedDescription], to: client)
                  }
                }
              }
              return
            }
            let result = try handler(method, message["params"] as? [String: Any] ?? [:])
            self.send(["id": id, "result": result], to: client)
          } catch { self.send(["id": id, "error": error.localizedDescription], to: client) }
        }
      }
      if complete || error != nil {
        DispatchQueue.main.async { self.disconnected(client) }
        client.cancel()
      } else {
        self.receive(client, buffer: pending)
      }
    }
  }

  private func send(_ object: [String: Any], to client: NWConnection) {
    let data: Data
    do { data = try JSONSerialization.data(withJSONObject: object) } catch {
      guard let id = object["id"],
        let response = try? JSONSerialization.data(withJSONObject: [
          "id": id, "error": "Native response encoding failed: \(error.localizedDescription)",
        ])
      else {
        client.cancel()
        return
      }
      client.send(content: response + Data([10]), completion: .contentProcessed { _ in })
      return
    }
    client.send(content: data + Data([10]), completion: .contentProcessed { _ in })
  }

  func emit(_ method: String, _ params: [String: Any]) {
    if let connection { send(["method": method, "params": params], to: connection) }
  }
}
