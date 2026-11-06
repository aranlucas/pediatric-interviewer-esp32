export const DEFAULT_INTERVIEW_QUESTION_COUNT = 6;

export const MIN_INTERVIEW_QUESTION_COUNT = 3;

export const MAX_INTERVIEW_QUESTION_COUNT = 10;

export const INTERVIEW_DIFFICULTIES = ["easy", "standard", "hard"] as const;

export type InterviewDifficulty = (typeof INTERVIEW_DIFFICULTIES)[number];

export const DEFAULT_INTERVIEW_DIFFICULTY: InterviewDifficulty = "standard";

export const INTERVIEW_STATUSES = [
  "idle",
  "thinking",
  "listening",
  "evaluating",
  "speaking",
  "complete",
  "error",
] as const;

export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const TOPIC_IDS = [
  "behavior_guidance",
  "growth_development",
  "facial_injury_emergency_surgery",
  "diagnosis_pathology_radiology_medicine",
  "prevention_health_promotion",
  "caries_management_restorative",
  "pulp_therapy",
  "special_health_care_needs",
  "advocacy_education",
  "pediatric_dental_practice",
] as const;

export type TopicId = (typeof TOPIC_IDS)[number];
