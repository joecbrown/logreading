// Models.swift
//
// Data models shared across the app. childId (Child.id) must match the
// lowercase convention the backend uses (api/handler.js lowercases it
// anyway, but we normalize here too so display and networking agree).

import Foundation

struct Child: Identifiable, Codable, Equatable, Hashable {
    let id: String          // slug used as childId in API calls, e.g. "emma"
    var displayName: String
    var grade: String?      // e.g. "6th grade" — for your reference only, not sent to the backend (yet)

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
}

/// Mirrors the response shape of GET /children/{childId}/balance
struct BalanceResponse: Codable {
    let weekId: String
    let bonusHoursEarned: Double
    let bonusHoursRemaining: Double
    let availableToday: Double
}

struct APIErrorResponse: Codable {
    let error: String
}
