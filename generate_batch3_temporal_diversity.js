/**
 * Batch 3 Scenario Generator: Temporal Diversity
 *
 * Tests if recency bias overwhelms relevance in MMR algorithm
 *
 * Distribution (50 scenarios):
 * - 15 scenarios: Recent entities (last 3 conversations)
 * - 15 scenarios: Old entities (2+ weeks ago)
 * - 10 scenarios: Mixed temporal (old relevant vs recent irrelevant)
 * - 10 scenarios: Time-explicit queries ("last week", "yesterday")
 *
 * ICP Distribution:
 * - 25 Developer Power Users
 * - 25 AI Companion Users
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ANTI-VALIDATION-THEATER DESIGN
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Lessons Applied from Batch 2 & 7:
 * ✅ Diverse competing entities (different entity names)
 * ✅ Overlapping distance ranges (primary can lose)
 * ✅ Random variance creates realistic competition
 * ✅ Ground truth labels for failure tracking
 * ✅ Temporal metadata for recency testing
 */

import { getCompetitors } from './competitor_entities.js';

// ═══════════════════════════════════════════════════════════════════════
// TEMPORAL METADATA HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Calculate days ago from recency category
 */
function getDaysAgo(recencyType) {
  const ranges = {
    recent: { min: 0, max: 3 },        // Last 3 days
    medium: { min: 7, max: 14 },       // 1-2 weeks ago
    old: { min: 14, max: 60 }          // 2+ weeks ago (up to 2 months)
  };

  const range = ranges[recencyType];
  return range.min + Math.random() * (range.max - range.min);
}

/**
 * Calculate recency score (0-1, higher = more recent)
 */
function getRecencyScore(daysAgo) {
  // Exponential decay: score = e^(-k * days)
  // k = 0.1 gives reasonable decay curve
  const k = 0.1;
  return Math.exp(-k * daysAgo);
}

/**
 * Generate timestamp from days ago
 */
function getTimestamp(daysAgo) {
  const now = new Date();
  const timestamp = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
  return timestamp.toISOString();
}

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO TEMPLATES
// ═══════════════════════════════════════════════════════════════════════

const TEMPORAL_SCENARIOS = {
  developer: {
    recent: [
      {
        name: "Recent Redis discussion",
        query: "Redis caching",
        primary: { entity: "Redis caching", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent Kubernetes deployment",
        query: "Kubernetes deployment",
        primary: { entity: "Kubernetes deployment", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent PostgreSQL optimization",
        query: "PostgreSQL query optimization",
        primary: { entity: "PostgreSQL query optimization", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent WebSocket implementation",
        query: "WebSocket real-time updates",
        primary: { entity: "WebSocket implementation", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent JWT authentication",
        query: "JWT authentication flow",
        primary: { entity: "JWT authentication", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent React hooks migration",
        query: "React hooks migration",
        primary: { entity: "React hooks migration", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent React component refactor",
        query: "React component refactoring",
        primary: { entity: "React hooks migration", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent API authentication",
        query: "API authentication setup",
        primary: { entity: "JWT authentication", recency: "recent" },
        temporalType: "recent_entities"
      }
    ],
    old: [
      {
        name: "Old Redis caching setup",
        query: "Redis caching strategy",
        primary: { entity: "Redis caching", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old Kubernetes architecture",
        query: "Kubernetes cluster design",
        primary: { entity: "Kubernetes deployment", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old PostgreSQL migration",
        query: "PostgreSQL schema migration",
        primary: { entity: "PostgreSQL query optimization", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old WebSocket design",
        query: "WebSocket connection handling",
        primary: { entity: "WebSocket implementation", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old JWT security",
        query: "JWT token security",
        primary: { entity: "JWT authentication", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old React architecture",
        query: "React application architecture",
        primary: { entity: "React hooks migration", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old authentication flow",
        query: "authentication implementation",
        primary: { entity: "JWT authentication", recency: "old" },
        temporalType: "old_entities"
      }
    ],
    mixed: [
      {
        name: "Old relevant vs recent irrelevant - React hooks",
        query: "React hooks migration approach",
        primary: { entity: "React hooks migration", recency: "old" },
        competitors: [
          { entity: "Redis caching", recency: "recent", similarity: "low" }
        ],
        temporalType: "mixed_temporal"
      },
      {
        name: "Old relevant vs recent irrelevant - WebSocket",
        query: "WebSocket connection handling",
        primary: { entity: "WebSocket implementation", recency: "old" },
        competitors: [
          { entity: "Kubernetes deployment", recency: "recent", similarity: "medium" }
        ],
        temporalType: "mixed_temporal"
      },
      {
        name: "Old relevant vs recent irrelevant - JWT",
        query: "JWT authentication strategy",
        primary: { entity: "JWT authentication", recency: "old" },
        competitors: [
          { entity: "PostgreSQL query optimization", recency: "recent", similarity: "low" }
        ],
        temporalType: "mixed_temporal"
      },
      {
        name: "Old relevant vs recent irrelevant - PostgreSQL",
        query: "PostgreSQL optimization techniques",
        primary: { entity: "PostgreSQL query optimization", recency: "old" },
        competitors: [
          { entity: "Redis caching", recency: "recent", similarity: "high" }
        ],
        temporalType: "mixed_temporal"
      },
      {
        name: "Old relevant vs recent irrelevant - Kubernetes",
        query: "Kubernetes scaling strategy",
        primary: { entity: "Kubernetes deployment", recency: "old" },
        competitors: [
          { entity: "WebSocket implementation", recency: "recent", similarity: "medium" }
        ],
        temporalType: "mixed_temporal"
      }
    ],
    timeExplicit: [
      {
        name: "Time-explicit: last sprint Redis setup",
        query: "the Redis setup from last sprint",
        primary: { entity: "Redis caching", recency: "medium" },
        temporalFilter: "last_sprint",
        temporalType: "time_explicit"
      },
      {
        name: "Time-explicit: yesterday's K8s deployment",
        query: "the Kubernetes deployment from yesterday",
        primary: { entity: "Kubernetes deployment", recency: "recent" },
        temporalFilter: "yesterday",
        temporalType: "time_explicit"
      },
      {
        name: "Time-explicit: last week's PostgreSQL work",
        query: "PostgreSQL optimization from last week",
        primary: { entity: "PostgreSQL query optimization", recency: "medium" },
        temporalFilter: "last_week",
        temporalType: "time_explicit"
      },
      {
        name: "Time-explicit: last month's WebSocket impl",
        query: "WebSocket implementation from last month",
        primary: { entity: "WebSocket implementation", recency: "old" },
        temporalFilter: "last_month",
        temporalType: "time_explicit"
      },
      {
        name: "Time-explicit: this morning's JWT discussion",
        query: "JWT discussion from this morning",
        primary: { entity: "JWT authentication", recency: "recent" },
        temporalFilter: "this_morning",
        temporalType: "time_explicit"
      }
    ]
  },
  companion: {
    recent: [
      {
        name: "Recent therapy session with Jennifer",
        query: "my therapy session",
        primary: { entity: "Therapist Jennifer session", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent work deadline anxiety",
        query: "anxiety about work deadline",
        primary: { entity: "Work deadline anxiety", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent breakup processing",
        query: "breakup with Alex",
        primary: { entity: "Breakup with Alex", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent sister Jennifer health concern",
        query: "sister's health issues",
        primary: { entity: "Sister Jennifer health concern", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent mother retirement planning",
        query: "mother's retirement",
        primary: { entity: "Mother retirement planning", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent friend Sarah new job",
        query: "Sarah's new job",
        primary: { entity: "Friend Sarah new job", recency: "recent" },
        temporalType: "recent_entities"
      },
      {
        name: "Recent anxiety management",
        query: "managing anxiety",
        primary: { entity: "Work deadline anxiety", recency: "recent" },
        temporalType: "recent_entities"
      }
    ],
    old: [
      {
        name: "Old therapy session",
        query: "therapy processing",
        primary: { entity: "Therapist Jennifer session", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old work anxiety",
        query: "work-related stress",
        primary: { entity: "Work deadline anxiety", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old relationship discussion",
        query: "relationship with Alex",
        primary: { entity: "Breakup with Alex", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old sister concerns",
        query: "Jennifer's situation",
        primary: { entity: "Sister Jennifer health concern", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old mother planning",
        query: "helping mother with retirement",
        primary: { entity: "Mother retirement planning", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old friend Sarah conversation",
        query: "Sarah's career change",
        primary: { entity: "Friend Sarah new job", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old therapy insights",
        query: "therapy learnings",
        primary: { entity: "Therapist Jennifer session", recency: "old" },
        temporalType: "old_entities"
      },
      {
        name: "Old stress management",
        query: "dealing with stress",
        primary: { entity: "Work deadline anxiety", recency: "old" },
        temporalType: "old_entities"
      }
    ],
    mixed: [
      {
        name: "Old relevant vs recent irrelevant - Therapy session",
        query: "processing from therapy",
        primary: { entity: "Therapist Jennifer session", recency: "old" },
        competitors: [
          { entity: "Work deadline anxiety", recency: "recent", similarity: "medium" }
        ],
        temporalType: "mixed_temporal"
      },
      {
        name: "Old relevant vs recent irrelevant - Breakup processing",
        query: "dealing with the breakup",
        primary: { entity: "Breakup with Alex", recency: "old" },
        competitors: [
          { entity: "Friend Sarah new job", recency: "recent", similarity: "low" }
        ],
        temporalType: "mixed_temporal"
      },
      {
        name: "Old relevant vs recent irrelevant - Jennifer health",
        query: "Jennifer's health situation",
        primary: { entity: "Sister Jennifer health concern", recency: "old" },
        competitors: [
          { entity: "Mother retirement planning", recency: "recent", similarity: "medium" }
        ],
        temporalType: "mixed_temporal"
      },
      {
        name: "Old relevant vs recent irrelevant - Work anxiety",
        query: "work deadline stress",
        primary: { entity: "Work deadline anxiety", recency: "old" },
        competitors: [
          { entity: "Therapist Jennifer session", recency: "recent", similarity: "high" }
        ],
        temporalType: "mixed_temporal"
      },
      {
        name: "Old relevant vs recent irrelevant - Mother planning",
        query: "mother's retirement plans",
        primary: { entity: "Mother retirement planning", recency: "old" },
        competitors: [
          { entity: "Breakup with Alex", recency: "recent", similarity: "low" }
        ],
        temporalType: "mixed_temporal"
      }
    ],
    timeExplicit: [
      {
        name: "Time-explicit: yesterday's therapy",
        query: "the therapy session from yesterday",
        primary: { entity: "Therapist Jennifer session", recency: "recent" },
        temporalFilter: "yesterday",
        temporalType: "time_explicit"
      },
      {
        name: "Time-explicit: last week's work stress",
        query: "work anxiety from last week",
        primary: { entity: "Work deadline anxiety", recency: "medium" },
        temporalFilter: "last_week",
        temporalType: "time_explicit"
      },
      {
        name: "Time-explicit: last month's breakup",
        query: "breakup conversation from last month",
        primary: { entity: "Breakup with Alex", recency: "old" },
        temporalFilter: "last_month",
        temporalType: "time_explicit"
      },
      {
        name: "Time-explicit: this morning's Jennifer health",
        query: "Jennifer's health this morning",
        primary: { entity: "Sister Jennifer health concern", recency: "recent" },
        temporalFilter: "this_morning",
        temporalType: "time_explicit"
      },
      {
        name: "Time-explicit: two weeks ago mother planning",
        query: "mother's retirement from two weeks ago",
        primary: { entity: "Mother retirement planning", recency: "medium" },
        temporalFilter: "two_weeks_ago",
        temporalType: "time_explicit"
      }
    ]
  }
};

// ═══════════════════════════════════════════════════════════════════════
// CANDIDATE GENERATION (Anti-Validation-Theater)
// ═══════════════════════════════════════════════════════════════════════

function generateCandidates(scenario) {
  const candidates = [];

  // PRIMARY ENTITY (Expected Winner)
  // Base distance: 0.20-0.27, with ±0.02 random variance = 0.18-0.29
  const primaryDaysAgo = getDaysAgo(scenario.primary.recency);
  const primaryRecencyScore = getRecencyScore(primaryDaysAgo);
  const primaryTimestamp = getTimestamp(primaryDaysAgo);

  // Generate 5 messages for primary entity
  for (let i = 0; i < 5; i++) {
    const baseDistance = 0.20 + i * 0.014;  // 0.20, 0.214, 0.228, 0.242, 0.256
    const randomVariance = (Math.random() - 0.5) * 0.04;  // ±0.02

    candidates.push({
      entity: scenario.primary.entity,
      distance: baseDistance + randomVariance,  // Effective range: 0.18-0.29
      timestamp: primaryTimestamp,
      daysAgo: primaryDaysAgo,
      recencyScore: primaryRecencyScore,
      ground_truth: 'primary'
    });
  }

  // DIVERSE ENTITIES (Competitors with Different Names and Temporal Characteristics)
  let diverse = [];

  if (scenario.competitors) {
    // Explicitly defined competitors (for mixed temporal scenarios)
    diverse = scenario.competitors;
  } else {
    // Get competitors from database
    const competitors = getCompetitors(scenario.primary.entity, 2, 1, 0);
    diverse = competitors.map((comp, idx) => ({
      entity: comp.entity,
      similarity: comp.similarity,
      recency: idx === 0 ? 'recent' : 'medium'  // First competitor is recent
    }));
  }

  diverse.forEach((diverseEntity, diverseIdx) => {
    const diverseDaysAgo = getDaysAgo(diverseEntity.recency);
    const diverseRecencyScore = getRecencyScore(diverseDaysAgo);
    const diverseTimestamp = getTimestamp(diverseDaysAgo);

    // Generate 2-3 messages per diverse entity
    const messageCount = 2 + Math.floor(Math.random() * 2);  // 2 or 3 messages

    for (let i = 0; i < messageCount; i++) {
      let baseDistance, distanceSpread;

      if (diverseEntity.similarity === 'high' || diverseIdx === 0) {
        // High similarity competitor - overlaps with primary
        baseDistance = 0.23;      // Base: 0.23
        distanceSpread = 0.013;   // Spread across messages
      } else {
        // Medium similarity competitor - mostly separated
        baseDistance = 0.30;      // Base: 0.30
        distanceSpread = 0.016;   // Spread across messages
      }

      const randomVariance = (Math.random() - 0.5) * 0.05;  // ±0.025
      const diverseDistance = baseDistance + i * distanceSpread + randomVariance;

      candidates.push({
        entity: diverseEntity.entity,
        distance: diverseDistance,  // High: 0.20-0.28 (overlaps!), Medium: 0.27-0.35
        timestamp: diverseTimestamp,
        daysAgo: diverseDaysAgo,
        recencyScore: diverseRecencyScore,
        ground_truth: diverseEntity.similarity === 'high' || diverseIdx === 0
          ? 'competitor_high'
          : 'competitor_medium'
      });
    }
  });

  return shuffleArray(candidates);
}

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO GENERATION
// ═══════════════════════════════════════════════════════════════════════

export function generateBatch3Scenarios() {
  const scenarios = [];
  let scenarioNum = 200;  // Start from 200 for Batch 3

  // Helper to create scenario
  function createScenario(template, icp) {
    scenarioNum++;

    const scenario = {
      num: scenarioNum,
      name: template.name,
      query: template.query,
      icp,
      temporalType: template.temporalType,
      primary: template.primary,
      competitors: template.competitors,
      temporalFilter: template.temporalFilter,
      expectedPrimary: template.primary.entity,
      expectedDiverse: []
    };

    // Add expected diverse entities
    if (template.competitors) {
      scenario.expectedDiverse = template.competitors.map(c => c.entity);
    } else {
      const competitors = getCompetitors(template.primary.entity, 2, 1, 0);
      scenario.expectedDiverse = competitors.map(c => c.entity);
    }

    // Generate candidates with temporal metadata
    scenario.candidates = generateCandidates(scenario);

    return scenario;
  }

  // DEVELOPER ICP (25 scenarios)
  // Recent entities: 8 scenarios
  TEMPORAL_SCENARIOS.developer.recent.forEach(template => {
    scenarios.push(createScenario(template, 'developer'));
  });

  // Old entities: 8 scenarios
  TEMPORAL_SCENARIOS.developer.old.forEach(template => {
    scenarios.push(createScenario(template, 'developer'));
  });

  // Mixed temporal: 5 scenarios
  TEMPORAL_SCENARIOS.developer.mixed.forEach(template => {
    scenarios.push(createScenario(template, 'developer'));
  });

  // Time-explicit: 5 scenarios
  TEMPORAL_SCENARIOS.developer.timeExplicit.forEach(template => {
    scenarios.push(createScenario(template, 'developer'));
  });

  // COMPANION ICP (25 scenarios)
  // Recent entities: 7 scenarios
  TEMPORAL_SCENARIOS.companion.recent.forEach(template => {
    scenarios.push(createScenario(template, 'companion'));
  });

  // Old entities: 7 scenarios
  TEMPORAL_SCENARIOS.companion.old.forEach(template => {
    scenarios.push(createScenario(template, 'companion'));
  });

  // Mixed temporal: 5 scenarios
  TEMPORAL_SCENARIOS.companion.mixed.forEach(template => {
    scenarios.push(createScenario(template, 'companion'));
  });

  // Time-explicit: 5 scenarios
  TEMPORAL_SCENARIOS.companion.timeExplicit.forEach(template => {
    scenarios.push(createScenario(template, 'companion'));
  });

  return scenarios;
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORT FOR TESTING
// ═══════════════════════════════════════════════════════════════════════

// Generate and log distribution if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const scenarios = generateBatch3Scenarios();

  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║       BATCH 3: TEMPORAL DIVERSITY SCENARIO DISTRIBUTION          ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  console.log(`Total Scenarios: ${scenarios.length}\n`);

  // Count by ICP
  const devScenarios = scenarios.filter(s => s.icp === 'developer');
  const compScenarios = scenarios.filter(s => s.icp === 'companion');
  console.log(`Developer ICP: ${devScenarios.length} scenarios`);
  console.log(`Companion ICP: ${compScenarios.length} scenarios\n`);

  // Count by temporal type
  const temporalTypes = {};
  scenarios.forEach(s => {
    temporalTypes[s.temporalType] = (temporalTypes[s.temporalType] || 0) + 1;
  });

  console.log('By Temporal Type:');
  Object.entries(temporalTypes).forEach(([type, count]) => {
    console.log(`  ${type.padEnd(25)}: ${count} scenarios`);
  });

  console.log('\n✅ All scenarios have overlapping distance ranges (no validation theater)');
  console.log('✅ Random variance creates realistic competition');
  console.log('✅ Ground truth labels for failure tracking');
  console.log('✅ Temporal metadata for recency testing\n');
}
