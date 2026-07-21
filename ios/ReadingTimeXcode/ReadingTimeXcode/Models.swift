// Models.swift
//
// Data models shared across the app. childId (Child.id) must match the
// lowercase convention the backend uses (api/handler.js lowercases it
// anyway, but we normalize here too so display and networking agree).

import Foundation

struct Child: Identifiable, Codable, Equatable, Hashable {
    let id: String          // slug used as childId in API calls, e.g. "emma"
    var displayName: String
    var grade: String?      // e.g. "6th grade" — now sent with upload-url requests, for question-difficulty calibration

    static func makeId(from name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

/// Mirrors the response shape of POST /children/{childId}/sessions
struct SessionLogResponse: Codable {
    let minutesRead: Double
    let hoursEarned: Double
    let wordsPerMinute: Double?
    let weekId: String
    let sessionId: String?
}

/// Mirrors the response shape of GET /children/{childId}/balance
struct BalanceResponse: Codable {
    let weekId: String
    let bonusHoursEarned: Double
    let bonusHoursRemaining: Double
    let availableToday: Double
}

/// Mirrors the response shape of POST /children/{childId}/sessions/upload-url
struct UploadUrlResponse: Codable {
    let sessionId: String
    let uploadUrl: String
    let s3Key: String
    let expiresIn: Int
}

/// One generated comprehension question, mirroring the shape Claude is
/// prompted to return (see lib/transcriptHelpers.js's buildQuestionGenerationPrompt).
struct ComprehensionQuestion: Codable, Identifiable {
    let question: String
    let guidance: String
    var id: String { question } // questions are unique enough within one session's set
}

/// Mirrors the response shape of GET /children/{childId}/sessions/{sessionId}/questions
struct QuestionsResponse: Codable {
    let questions: [ComprehensionQuestion]
    let generatedAt: String
}

struct APIErrorResponse: Codable {
    let error: String
}
