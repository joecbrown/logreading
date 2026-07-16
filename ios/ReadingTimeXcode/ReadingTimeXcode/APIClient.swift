// APIClient.swift
//
// Talks to the REST API in api/handler.js. The base URL isn't known until
// the API Gateway HTTP API is actually deployed (see README's "Deploying
// the REST API" section), so it's stored in UserDefaults and editable from
// SettingsView rather than hardcoded.

import Foundation

enum APIError: LocalizedError {
    case notConfigured
    case server(String)
    case network(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Set the API base URL in Settings before using the app."
        case .server(let message):
            return message
        case .network(let error):
            return "Network error: \(error.localizedDescription)"
        case .decoding(let error):
            return "Unexpected response from server: \(error.localizedDescription)"
        }
    }
}

@MainActor
final class APIClient {
    static let shared = APIClient()

    private let baseURLKey = "reading_time.api_base_url"

    var baseURL: URL? {
        get {
            guard let raw = UserDefaults.standard.string(forKey: baseURLKey) else { return nil }
            return URL(string: raw)
        }
        set {
            UserDefaults.standard.set(newValue?.absoluteString, forKey: baseURLKey)
        }
    }

    /// Logs a completed session. minutesRead should already be net of any
    /// local auto-pauses — the backend has no visibility into pauses that
    /// happened on-device, so it trusts this value as-is.
    func logSession(childId: String, minutesRead: Double, wordsRead: Int? = nil) async throws -> SessionLogResponse {
        guard let base = baseURL else { throw APIError.notConfigured }
        let url = base.appendingPathComponent("children/\(childId)/sessions")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["minutesRead": minutesRead]
        if let wordsRead {
            body["wordsRead"] = wordsRead
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return try await send(request, as: SessionLogResponse.self)
    }

    func getBalance(childId: String) async throws -> BalanceResponse {
        guard let base = baseURL else { throw APIError.notConfigured }
        let url = base.appendingPathComponent("children/\(childId)/balance")
        let request = URLRequest(url: url)
        return try await send(request, as: BalanceResponse.self)
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.network(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.server("No HTTP response")
        }

        guard (200..<300).contains(http.statusCode) else {
            if let errBody = try? JSONDecoder().decode(APIErrorResponse.self, from: data) {
                throw APIError.server(errBody.error)
            }
            throw APIError.server("Request failed with status \(http.statusCode)")
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }
}
