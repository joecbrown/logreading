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
    /// happened on-device, so it trusts this value as-is. Pass sessionId
    /// (from requestUploadUrl, below) to link this entry to whatever
    /// transcription/WPM/questions complete for it later.
    func logSession(childId: String, minutesRead: Double, wordsRead: Int? = nil, sessionId: String? = nil) async throws -> SessionLogResponse {
        guard let base = baseURL else { throw APIError.notConfigured }
        let url = base.appendingPathComponent("children/\(childId)/sessions")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["minutesRead": minutesRead]
        if let wordsRead {
            body["wordsRead"] = wordsRead
        }
        if let sessionId {
            body["sessionId"] = sessionId
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

    /// Requests a sessionId + presigned S3 upload URL for this child's
    /// recording. Call this BEFORE logSession, then uploadAudio, then
    /// logSession with the returned sessionId — see
    /// ReadingSessionViewModel.stopSession for the full sequence.
    /// displayName is used for the "comprehension questions ready" email
    /// (addressing it by the child's actual name, not the lowercase
    /// childId slug used internally).
    func requestUploadUrl(childId: String, grade: String?, displayName: String?) async throws -> UploadUrlResponse {
        guard let base = baseURL else { throw APIError.notConfigured }
        let url = base.appendingPathComponent("children/\(childId)/sessions/upload-url")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [:]
        if let displayName {
            body["displayName"] = displayName
        }
        if let grade {
            body["grade"] = grade
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return try await send(request, as: UploadUrlResponse.self)
    }

    /// Uploads the recorded audio file directly to S3 using a presigned
    /// URL — this does NOT go through our API/Lambda at all, since a
    /// multi-minute recording is far too large for API Gateway's payload
    /// limits. This is a plain S3 PUT, not our usual JSON request/response
    /// shape, so it doesn't go through `send(_:as:)`.
    func uploadAudio(fileURL: URL, to uploadUrlString: String) async throws {
        guard let uploadUrl = URL(string: uploadUrlString) else {
            throw APIError.server("Invalid upload URL received from server")
        }
        var request = URLRequest(url: uploadUrl)
        request.httpMethod = "PUT"
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")

        let (_, response): (Data, URLResponse)
        do {
            (_, response) = try await URLSession.shared.upload(for: request, fromFile: fileURL)
        } catch {
            throw APIError.network(error)
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.server("Audio upload failed")
        }
    }

    /// Fetches generated comprehension questions for a session, once the
    /// async transcription pipeline has finished. Returns nil (not an
    /// error) if they're not ready yet — the caller can retry later
    /// rather than treating a 404 as a real failure.
    func getQuestions(childId: String, sessionId: String) async throws -> QuestionsResponse? {
        guard let base = baseURL else { throw APIError.notConfigured }
        let url = base.appendingPathComponent("children/\(childId)/sessions/\(sessionId)/questions")
        let request = URLRequest(url: url)
        do {
            return try await send(request, as: QuestionsResponse.self)
        } catch APIError.server(let message) where message.contains("not ready") {
            return nil
        }
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
