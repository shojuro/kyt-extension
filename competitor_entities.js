/**
 * Competitor Entity Database for K.Y.T. Memory Extension Testing
 *
 * Purpose: Provide realistic competing entities to test MMR disambiguation
 *
 * For each primary entity, we define:
 * - high_similarity: Competitors that are very similar (hard to distinguish)
 * - medium_similarity: Competitors that are plausible but distinguishable
 * - low_similarity: Distractors that should clearly lose
 *
 * This enables REAL testing where wrong answers can win.
 */

export const COMPETITOR_DATABASE = {
  // ═══════════════════════════════════════════════════════════════════════
  // DEVELOPER ICP ENTITIES
  // ═══════════════════════════════════════════════════════════════════════

  "Redis caching": {
    high_similarity: [
      "Memcached implementation",
      "In-memory caching strategies",
      "Database query caching"
    ],
    medium_similarity: [
      "API response caching",
      "CDN configuration",
      "Browser cache optimization"
    ],
    low_similarity: [
      "Frontend component design",
      "Mobile app navigation",
      "CSS animation performance"
    ]
  },

  "PostgreSQL query optimization": {
    high_similarity: [
      "MySQL performance tuning",
      "SQL query optimization",
      "Database indexing strategies"
    ],
    medium_similarity: [
      "NoSQL database design",
      "GraphQL resolver optimization",
      "ORM query performance"
    ],
    low_similarity: [
      "Kubernetes deployment",
      "React state management",
      "OAuth implementation"
    ]
  },

  "Kubernetes deployment": {
    high_similarity: [
      "Docker container orchestration",
      "ECS deployment strategies",
      "Cloud infrastructure setup"
    ],
    medium_similarity: [
      "CI/CD pipeline configuration",
      "Serverless architecture",
      "Load balancer setup"
    ],
    low_similarity: [
      "Database migration scripts",
      "Frontend build optimization",
      "API authentication flow"
    ]
  },

  "WebSocket implementation": {
    high_similarity: [
      "Real-time communication setup",
      "Socket.io configuration",
      "Server-sent events implementation"
    ],
    medium_similarity: [
      "HTTP polling strategies",
      "REST API design",
      "GraphQL subscriptions"
    ],
    low_similarity: [
      "CSS grid layouts",
      "Image optimization",
      "Password hashing"
    ]
  },

  "JWT authentication": {
    high_similarity: [
      "OAuth implementation",
      "Session token management",
      "API authentication flow"
    ],
    medium_similarity: [
      "User authorization logic",
      "Password reset flow",
      "Multi-factor authentication"
    ],
    low_similarity: [
      "Database query optimization",
      "Frontend routing",
      "File upload handling"
    ]
  },

  // ═══════════════════════════════════════════════════════════════════════
  // COMPANION ICP ENTITIES
  // ═══════════════════════════════════════════════════════════════════════

  "Work deadline anxiety": {
    high_similarity: [
      "Project deadline stress",
      "Time pressure at work",
      "Performance review anxiety"
    ],
    medium_similarity: [
      "General work stress",
      "Career uncertainty",
      "Work-life balance concerns"
    ],
    low_similarity: [
      "Weekend vacation planning",
      "Cooking recipe ideas",
      "Home decoration choices"
    ]
  },

  "Sister Jennifer health concern": {
    high_similarity: [
      "Jennifer medical update",
      "Family health worries",
      "Sister's hospital visit"
    ],
    medium_similarity: [
      "General family health",
      "Healthcare navigation",
      "Medical insurance questions"
    ],
    low_similarity: [
      "Work project deadline",
      "Restaurant recommendations",
      "Fitness routine planning"
    ]
  },

  "Breakup with Alex": {
    high_similarity: [
      "Alex relationship ending",
      "Romantic breakup processing",
      "Post-relationship emotions"
    ],
    medium_similarity: [
      "Dating advice",
      "Relationship communication",
      "Emotional support needs"
    ],
    low_similarity: [
      "Career advancement strategy",
      "Home renovation ideas",
      "Travel destination planning"
    ]
  },

  "Mother retirement planning": {
    high_similarity: [
      "Mom's retirement finances",
      "Parent retirement support",
      "Retirement planning advice"
    ],
    medium_similarity: [
      "Financial planning",
      "Investment strategies",
      "Elder care options"
    ],
    low_similarity: [
      "Breakup recovery",
      "Job interview preparation",
      "Cooking new recipes"
    ]
  },

  "Therapist Jennifer session": {
    high_similarity: [
      "Jennifer therapy appointment",
      "Counseling session notes",
      "Mental health support"
    ],
    medium_similarity: [
      "Anxiety management",
      "Stress coping strategies",
      "Self-care practices"
    ],
    low_similarity: [
      "Weekend trip planning",
      "Car maintenance",
      "Book recommendations"
    ]
  },

  // Additional entities for query complexity testing
  "React hooks migration": {
    high_similarity: [
      "React class to hooks refactor",
      "useState implementation",
      "React component modernization"
    ],
    medium_similarity: [
      "React state management",
      "Component lifecycle",
      "React performance optimization"
    ],
    low_similarity: [
      "Database schema design",
      "API rate limiting",
      "Email template design"
    ]
  },

  "Friend Sarah new job": {
    high_similarity: [
      "Sarah career change",
      "Friend's job transition",
      "Sarah work update"
    ],
    medium_similarity: [
      "Career advice",
      "Job search strategies",
      "Professional networking"
    ],
    low_similarity: [
      "Cooking dinner ideas",
      "Exercise routine",
      "Netflix recommendations"
    ]
  }
};

/**
 * Get competitor entities for testing
 *
 * @param {string} primaryEntity - The entity that should win
 * @param {number} highCount - Number of high similarity competitors
 * @param {number} mediumCount - Number of medium similarity competitors
 * @param {number} lowCount - Number of low similarity competitors
 * @returns {Array} Competitor entities with similarity labels
 */
export function getCompetitors(primaryEntity, highCount = 2, mediumCount = 2, lowCount = 1) {
  const competitors = COMPETITOR_DATABASE[primaryEntity];

  if (!competitors) {
    throw new Error(`No competitors defined for entity: "${primaryEntity}". Available entities: ${Object.keys(COMPETITOR_DATABASE).join(', ')}`);
  }

  const selected = [];

  // High similarity competitors (hardest to distinguish)
  if (competitors.high_similarity) {
    competitors.high_similarity.slice(0, highCount).forEach(entity => {
      selected.push({ entity, similarity: 'high' });
    });
  }

  // Medium similarity competitors
  if (competitors.medium_similarity) {
    competitors.medium_similarity.slice(0, mediumCount).forEach(entity => {
      selected.push({ entity, similarity: 'medium' });
    });
  }

  // Low similarity distractors
  if (competitors.low_similarity) {
    competitors.low_similarity.slice(0, lowCount).forEach(entity => {
      selected.push({ entity, similarity: 'low' });
    });
  }

  return selected;
}

/**
 * Check if an entity exists in the database
 */
export function hasCompetitors(primaryEntity) {
  return primaryEntity in COMPETITOR_DATABASE;
}

/**
 * Get all available entities (for debugging/testing)
 */
export function getAllEntities() {
  return Object.keys(COMPETITOR_DATABASE);
}
