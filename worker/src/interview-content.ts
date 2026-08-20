export const ABPD_OCE_BLUEPRINT_URL =
  "https://www.abpd.org/become-certified/oral-clinical-examination/oce-blueprint";

export type CognitiveLevel = "remember" | "understand_apply" | "analyze_evaluate";

export type Competency = {
  skillset: string;
  cognitiveLevel: CognitiveLevel;
};

export type InterviewTopic = {
  id: string;
  label: string;
  blueprintWeight: number;
  studyMaterial: string;
  objectives: string;
  caseScope: string;
  competencies: readonly Competency[];
};

export const PEDIATRIC_TOPICS = [
  {
    id: "behavior_guidance",
    label: "Behavior Guidance",
    blueprintWeight: 14,
    studyMaterial: "AAPD Behavior Guidance for the Pediatric Dental Patient",
    objectives:
      "development and temperament assessment, communication, non-pharmacologic and pharmacologic guidance, pain, consent, monitoring, and adverse-event management",
    caseScope:
      "Create a pediatric case in which cooperation, development, anxiety, treatment urgency, caregiver communication, and the least restrictive safe treatment approach all matter.",
    competencies: [
      {
        skillset: "Physical, psychological, and social development assessment",
        cognitiveLevel: "analyze_evaluate",
      },
      { skillset: "Temperament and cooperation potential", cognitiveLevel: "analyze_evaluate" },
      {
        skillset: "Individualized non-pharmacologic behavior guidance",
        cognitiveLevel: "understand_apply",
      },
      {
        skillset: "Patient and guardian communication and consent",
        cognitiveLevel: "understand_apply",
      },
      {
        skillset: "Pharmacologic options, indications, and contraindications",
        cognitiveLevel: "analyze_evaluate",
      },
      {
        skillset: "Pain, monitoring, safety, and adverse-event management",
        cognitiveLevel: "analyze_evaluate",
      },
    ],
  },
  {
    id: "growth_development",
    label: "Growth & Development",
    blueprintWeight: 8,
    studyMaterial: "AAPD Management of the Developing Dentition and Occlusion",
    objectives:
      "growth patterns, developing dentition, records, space management, functional abnormalities, interceptive care, referral, and follow-up",
    caseScope:
      "Create a primary- or mixed-dentition case requiring age-appropriate growth, eruption, occlusal, functional, imaging, and intervention decisions.",
    competencies: [
      { skillset: "Dentofacial growth and facial analysis", cognitiveLevel: "understand_apply" },
      {
        skillset: "Dental, skeletal, and functional abnormality",
        cognitiveLevel: "understand_apply",
      },
      {
        skillset: "Developing dentition diagnosis and management",
        cognitiveLevel: "understand_apply",
      },
      {
        skillset: "Radiographic and orthodontic record interpretation",
        cognitiveLevel: "analyze_evaluate",
      },
      {
        skillset: "Space maintenance and interceptive appliances",
        cognitiveLevel: "understand_apply",
      },
      {
        skillset: "Treatment timing, follow-up, and specialist referral",
        cognitiveLevel: "analyze_evaluate",
      },
    ],
  },
  {
    id: "facial_injury_emergency_surgery",
    label: "Oral Facial Injury, Emergency Care & Oral Surgery",
    blueprintWeight: 16,
    studyMaterial: "AAPD acute pediatric dental trauma and oral surgery guidance",
    objectives:
      "trauma and infection assessment, hard- and soft-tissue management, safeguarding, surgical decisions, prognosis, emergencies, and follow-up",
    caseScope:
      "Create an acute pediatric trauma, pain, infection, or oral-surgery case with evolving diagnostic and management information.",
    competencies: [
      { skillset: "Emergency assessment and triage", cognitiveLevel: "analyze_evaluate" },
      { skillset: "Dentoalveolar and jaw injury diagnosis", cognitiveLevel: "analyze_evaluate" },
      {
        skillset: "Pulpal, periodontal, hard-, and soft-tissue management",
        cognitiveLevel: "analyze_evaluate",
      },
      { skillset: "Safeguarding and non-accidental trauma", cognitiveLevel: "understand_apply" },
      { skillset: "Surgical treatment and referral decisions", cognitiveLevel: "understand_apply" },
      {
        skillset: "Prognosis, sequelae, emergencies, and follow-up",
        cognitiveLevel: "analyze_evaluate",
      },
    ],
  },
  {
    id: "diagnosis_pathology_radiology_medicine",
    label: "Diagnosis, Oral Pathology, Oral Radiology, and Oral Medicine",
    blueprintWeight: 10,
    studyMaterial:
      "AAPD Reference Manual diagnostic, radiographic, pathology, and oral medicine guidance",
    objectives:
      "normal and abnormal findings, differential diagnosis, radiographic planning and interpretation, medication, periodontal and TMJ disorders, referral, and safety-netting",
    caseScope:
      "Create a pediatric diagnostic case with an oral, facial, radiographic, periodontal, or temporomandibular finding that requires a defensible differential and safe plan.",
    competencies: [
      { skillset: "Normal versus abnormal pediatric findings", cognitiveLevel: "analyze_evaluate" },
      {
        skillset: "Differential diagnosis of oral and facial conditions",
        cognitiveLevel: "analyze_evaluate",
      },
      { skillset: "Radiographic survey selection", cognitiveLevel: "understand_apply" },
      {
        skillset: "Radiographic interpretation and error recognition",
        cognitiveLevel: "understand_apply",
      },
      { skillset: "Medication and nonsurgical management", cognitiveLevel: "understand_apply" },
      { skillset: "Referral, communication, and follow-up", cognitiveLevel: "understand_apply" },
    ],
  },
  {
    id: "prevention_health_promotion",
    label: "Prevention & Health Promotion",
    blueprintWeight: 10,
    studyMaterial:
      "AAPD preventive dentistry, periodicity, fluoride, diet, sealant, and anticipatory guidance resources",
    objectives:
      "medical and dental assessment, caries and trauma risk, individualized prevention, communication, behavior change, fluoride, diet, oral hygiene, and recall",
    caseScope:
      "Create an age-specific preventive visit in which history, examination, family behaviors, risk, access, and longitudinal planning must be integrated.",
    competencies: [
      {
        skillset: "Medical, dental, and comprehensive oral assessment",
        cognitiveLevel: "understand_apply",
      },
      { skillset: "Caries, periodontal, and trauma risk", cognitiveLevel: "analyze_evaluate" },
      { skillset: "Individualized prevention planning", cognitiveLevel: "analyze_evaluate" },
      {
        skillset: "Findings and recommendations communication",
        cognitiveLevel: "analyze_evaluate",
      },
      {
        skillset: "Diet, oral hygiene, fluoride, and behavior change",
        cognitiveLevel: "understand_apply",
      },
      { skillset: "Needs-based recall and reassessment", cognitiveLevel: "understand_apply" },
    ],
  },
  {
    id: "caries_management_restorative",
    label: "Dental Caries Diagnosis, Non-Restorative Caries Management and Restorative Treatment",
    blueprintWeight: 17,
    studyMaterial:
      "AAPD Caries-risk Assessment, Nonrestorative Treatments, and Restorative Dentistry guidance",
    objectives:
      "lesion detection and activity, progression, nonoperative and minimally invasive care, deep caries, material and restoration selection, prognosis, and reassessment",
    caseScope:
      "Create a primary-, mixed-, or permanent-dentition caries case with enough uncertainty to test lesion activity, risk, tooth prognosis, and restorative versus nonrestorative decisions.",
    competencies: [
      {
        skillset: "Lesion detection and diagnostic method selection",
        cognitiveLevel: "analyze_evaluate",
      },
      { skillset: "Caries activity, progression, and risk", cognitiveLevel: "analyze_evaluate" },
      {
        skillset: "Nonoperative and minimally invasive management",
        cognitiveLevel: "understand_apply",
      },
      { skillset: "Deep caries and pulp-preserving decisions", cognitiveLevel: "understand_apply" },
      {
        skillset: "Restorative material and full-coverage selection",
        cognitiveLevel: "understand_apply",
      },
      { skillset: "Follow-up, reassessment, and prognosis", cognitiveLevel: "analyze_evaluate" },
    ],
  },
  {
    id: "pulp_therapy",
    label: "Pulp Therapy",
    blueprintWeight: 8,
    studyMaterial: "AAPD Pulp Therapy for Primary and Immature Permanent Teeth",
    objectives:
      "pulpal diagnosis, restorability, vital and nonvital therapy in primary and permanent teeth, apexogenesis, apexification, regenerative care, prognosis, and follow-up",
    caseScope:
      "Create a primary or immature permanent tooth case with symptoms and findings that require pulpal diagnosis, restorability, treatment selection, and follow-up reasoning.",
    competencies: [
      {
        skillset: "History, examination, imaging, and pulpal diagnosis",
        cognitiveLevel: "analyze_evaluate",
      },
      { skillset: "Restorability and prognosis", cognitiveLevel: "analyze_evaluate" },
      { skillset: "Primary-tooth vital pulp therapy", cognitiveLevel: "understand_apply" },
      { skillset: "Primary-tooth nonvital therapy", cognitiveLevel: "understand_apply" },
      { skillset: "Immature permanent-tooth vital therapy", cognitiveLevel: "understand_apply" },
      {
        skillset: "Apexification, regenerative care, and follow-up",
        cognitiveLevel: "understand_apply",
      },
    ],
  },
  {
    id: "special_health_care_needs",
    label: "Special Health Care Needs",
    blueprintWeight: 8,
    studyMaterial: "AAPD Management of Dental Patients with Special Health Care Needs",
    objectives:
      "needs and oral manifestations, medical-oral relationships, accommodations, modified treatment goals, prevention, communication, interdisciplinary coordination, and transition",
    caseScope:
      "Create a case in which a congenital or acquired condition materially affects communication, prevention, treatment modality, setting, coordination, or long-term care.",
    competencies: [
      { skillset: "Recognition of needs and care challenges", cognitiveLevel: "analyze_evaluate" },
      { skillset: "Associated oral manifestations", cognitiveLevel: "understand_apply" },
      { skillset: "Oral-systemic relationship communication", cognitiveLevel: "understand_apply" },
      { skillset: "Treatment and setting modification", cognitiveLevel: "analyze_evaluate" },
      { skillset: "Alternative goals and preventive guidance", cognitiveLevel: "understand_apply" },
      {
        skillset: "Interdisciplinary coordination and continuity",
        cognitiveLevel: "analyze_evaluate",
      },
    ],
  },
  {
    id: "advocacy_education",
    label: "Advocacy and Education",
    blueprintWeight: 4,
    studyMaterial: "ABPD OCE blueprint and current AAPD oral-health policy resources",
    objectives:
      "culturally responsive care, dental-home education, access and social-resource advocacy, community programs, public-health policy, and evaluation",
    caseScope:
      "Create an individual, community, or systems-level pediatric oral-health scenario with cultural, access, education, referral, or policy implications.",
    competencies: [
      { skillset: "Social and cultural awareness", cognitiveLevel: "understand_apply" },
      { skillset: "Dental-home and early-care education", cognitiveLevel: "understand_apply" },
      {
        skillset: "Caregiver and interprofessional communication",
        cognitiveLevel: "understand_apply",
      },
      {
        skillset: "Access barriers and social support resources",
        cognitiveLevel: "understand_apply",
      },
      { skillset: "Community oral-health programs", cognitiveLevel: "understand_apply" },
      {
        skillset: "Public-health advocacy and outcome evaluation",
        cognitiveLevel: "analyze_evaluate",
      },
    ],
  },
  {
    id: "pediatric_dental_practice",
    label: "Elements of Pediatric Dental Practice",
    blueprintWeight: 5,
    studyMaterial:
      "ABPD OCE blueprint and AAPD clinical practice, risk management, and safety resources",
    objectives:
      "professionalism, ethics, infection control, safety, privacy, clinical and teledentistry protocols, evidence appraisal, quality improvement, and risk management",
    caseScope:
      "Create a pediatric-practice systems scenario involving a safety, ethical, privacy, protocol, technology, evidence, or quality concern.",
    competencies: [
      { skillset: "Professional and ethical practice", cognitiveLevel: "understand_apply" },
      { skillset: "Infection control and patient safety", cognitiveLevel: "understand_apply" },
      { skillset: "Clinical protocols and risk management", cognitiveLevel: "understand_apply" },
      { skillset: "Privacy, technology, and teledentistry", cognitiveLevel: "understand_apply" },
      {
        skillset: "Professional standards and quality improvement",
        cognitiveLevel: "analyze_evaluate",
      },
      {
        skillset: "Evidence appraisal and clinical application",
        cognitiveLevel: "analyze_evaluate",
      },
    ],
  },
] as const satisfies readonly InterviewTopic[];

export type PediatricTopic = (typeof PEDIATRIC_TOPICS)[number];
export type PediatricTopicId = PediatricTopic["id"];

export function findTopic(value: string | null | undefined): PediatricTopic {
  return PEDIATRIC_TOPICS.find((topic) => topic.id === value) ?? PEDIATRIC_TOPICS[0];
}

export function knownTopic(value: string | null | undefined): PediatricTopic | null {
  return PEDIATRIC_TOPICS.find((topic) => topic.id === value) ?? null;
}
