/**
 * Batch 2: Query Complexity Variations (50 scenarios)
 *
 * Customized for K.Y.T. ICPs:
 * - 25 Developer Power User scenarios
 * - 25 AI Companion User scenarios
 *
 * Tests how query formulation affects retrieval across:
 * - Single-word queries
 * - Context queries
 * - Full sentence queries
 * - Vague queries
 * - Clarified queries
 */

/**
 * Create normalized test embedding
 */
function createTestEmbedding(values) {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map(v => v / magnitude);
}

/**
 * Generate embedding with controlled similarity
 *
 * CALIBRATED TO REAL OPENAI EMBEDDINGS (text-embedding-3-small)
 * Real validation showed:
 * - Primary entities: distance ~0.3-0.4 from query
 * - Diverse entities: distance ~0.5-0.6 from query
 *
 * Previous synthetic embeddings were 97% too optimistic (distances 0.01-0.03)
 */
function genEmb(relevance, diversity = 0.5) {
  const base = [];

  // Generate random high-dimensional embedding (simulating 1536-dim OpenAI)
  for (let i = 0; i < 10; i++) {
    // Much more random variation to match real embedding spread
    if (i < 3) {
      // Relevance components - much weaker signal than before
      base.push(relevance * (0.3 + Math.random() * 0.2));
    } else if (i < 6) {
      // Diversity components - stronger noise
      base.push((1 - relevance) * diversity * (0.6 + Math.random() * 0.4));
    } else {
      // Noise components - much stronger
      base.push(Math.random() * 0.8 - 0.4);
    }
  }

  return createTestEmbedding(base);
}

/**
 * Calculate distance from embedding similarity
 */
function similarityToDistance(similarity) {
  return 1 - similarity;
}

// ═══════════════════════════════════════════════════════════════════════
// DEVELOPER POWER USER SCENARIOS (25 scenarios)
// ═══════════════════════════════════════════════════════════════════════

const developerScenarios = [
  // Single-word queries (5 scenarios)
  {
    num: 51,
    icp: 'developer',
    queryType: 'single_word',
    name: 'Single word: "Redis"',
    query: 'Redis',
    primary: { entity: 'project_alpha_redis', count: 50 },
    diverse: [
      { entity: 'project_beta_cache', count: 30 },
      { entity: 'tutorial_redis', count: 10 }
    ],
    primaryMessages: [
      'We implemented Redis caching for the user session store in Project Alpha',
      'Redis cluster is handling 10k req/sec in production for Alpha',
      'Need to upgrade Redis version for Alpha - security patch available',
      'Project Alpha Redis memory usage spiked to 8GB yesterday',
      'Alpha team decided on Redis Cluster over Sentinel for HA'
    ],
    diverseMessages: {
      'project_beta_cache': [
        'Project Beta uses Memcached instead of Redis for now',
        'Beta team considering migrating to Redis next quarter',
        'Cache hit rate in Beta is only 60%, need optimization'
      ],
      'tutorial_redis': [
        'Read Redis tutorial about sorted sets implementation',
        'Redis Streams tutorial helpful for event sourcing'
      ]
    }
  },

  {
    num: 52,
    icp: 'developer',
    queryType: 'single_word',
    name: 'Single word: "Docker"',
    query: 'Docker',
    primary: { entity: 'project_gamma_docker', count: 40 },
    diverse: [
      { entity: 'devops_docker_general', count: 25 },
      { entity: 'tutorial_docker', count: 8 }
    ],
    primaryMessages: [
      'Project Gamma Dockerfile optimized - reduced image size by 60%',
      'Gamma containers crashing on startup - investigating Docker logs',
      'Migrated Gamma to multi-stage Docker builds for faster CI',
      'Docker Compose setup for Gamma local development environment',
      'Gamma production uses Docker Swarm for orchestration'
    ],
    diverseMessages: {
      'devops_docker_general': [
        'Updated Docker version across all dev machines to 24.0',
        'Docker Hub rate limits affecting our CI pipeline',
        'Need Docker training for new team members'
      ],
      'tutorial_docker': [
        'Docker networking tutorial - bridge vs overlay modes',
        'Best practices for Docker security scanning'
      ]
    }
  },

  {
    num: 53,
    icp: 'developer',
    queryType: 'single_word',
    name: 'Single word: "API"',
    query: 'API',
    primary: { entity: 'project_delta_api', count: 60 },
    diverse: [
      { entity: 'project_epsilon_api', count: 35 },
      { entity: 'api_design_patterns', count: 12 }
    ],
    primaryMessages: [
      'Project Delta REST API reaching 500 errors under load testing',
      'Delta API authentication migrated to OAuth2 with refresh tokens',
      'Need to version Delta API - breaking changes in v2.0',
      'Delta API rate limiting implemented - 1000 req/min per user',
      'GraphQL vs REST discussion for Delta API expansion'
    ],
    diverseMessages: {
      'project_epsilon_api': [
        'Epsilon API uses gRPC for internal microservices',
        'Epsilon team struggling with API documentation - need Swagger',
        'Epsilon API performance issues with N+1 queries'
      ],
      'api_design_patterns': [
        'Read article on API gateway patterns for microservices',
        'HATEOAS vs simple REST - design philosophy discussion'
      ]
    }
  },

  {
    num: 54,
    icp: 'developer',
    queryType: 'single_word',
    name: 'Single word: "Database"',
    query: 'Database',
    primary: { entity: 'project_alpha_postgres', count: 55 },
    diverse: [
      { entity: 'project_beta_mysql', count: 30 },
      { entity: 'database_migration_tools', count: 15 }
    ],
    primaryMessages: [
      'Project Alpha Postgres slow query identified - missing index on users table',
      'Alpha database backup strategy changed to continuous WAL archiving',
      'Postgres connection pool exhaustion in Alpha - increased max_connections',
      'Alpha team debating read replicas vs connection pooler for scale',
      'Database schema migration for Alpha - adding JSONB column for metadata'
    ],
    diverseMessages: {
      'project_beta_mysql': [
        'Project Beta MySQL replication lag hitting 5 seconds under load',
        'Beta considering Postgres migration for better JSONB support',
        'MySQL 8.0 upgrade for Beta scheduled next month'
      ],
      'database_migration_tools': [
        'Flyway vs Liquibase comparison for migration management',
        'Zero-downtime migration strategies for large tables'
      ]
    }
  },

  {
    num: 55,
    icp: 'developer',
    queryType: 'single_word',
    name: 'Single word: "Testing"',
    query: 'Testing',
    primary: { entity: 'project_gamma_testing', count: 45 },
    diverse: [
      { entity: 'ci_cd_testing', count: 28 },
      { entity: 'testing_best_practices', count: 10 }
    ],
    primaryMessages: [
      'Project Gamma unit test coverage increased to 85%',
      'Gamma integration tests flaky - race conditions in async code',
      'Added Playwright e2e tests for Gamma critical user flows',
      'Gamma team adopted TDD - productivity dropped initially but improving',
      'Mutation testing revealed gaps in Gamma test suite'
    ],
    diverseMessages: {
      'ci_cd_testing': [
        'CI pipeline running tests in parallel - reduced time by 40%',
        'Test environment provisioning automated with Terraform',
        'Flaky test detection added to CI - auto-retry on failure'
      ],
      'testing_best_practices': [
        'Read article on testing pyramid vs testing trophy',
        'Contract testing for microservices with Pact'
      ]
    }
  },

  // Context queries (5 scenarios)
  {
    num: 56,
    icp: 'developer',
    queryType: 'context_query',
    name: 'Context: "my Redis caching strategy"',
    query: 'my Redis caching strategy',
    primary: { entity: 'project_alpha_redis', count: 50 },
    diverse: [
      { entity: 'project_beta_cache', count: 30 },
      { entity: 'tutorial_redis', count: 10 }
    ],
    primaryMessages: [
      'Implemented Redis caching strategy for Alpha - write-through pattern',
      'Alpha Redis TTL set to 1 hour for user sessions',
      'Cache invalidation strategy for Alpha uses pub/sub pattern',
      'Redis cache hit rate in Alpha is 92% after optimization',
      'Alpha caching layer handles 15k reads/sec in production'
    ],
    diverseMessages: {
      'project_beta_cache': [
        'Beta caching is ad-hoc, no consistent strategy yet',
        'Beta team reviewing Alpha caching approach for adoption'
      ],
      'tutorial_redis': [
        'Redis caching patterns tutorial - cache-aside vs write-through'
      ]
    }
  },

  {
    num: 57,
    icp: 'developer',
    queryType: 'context_query',
    name: 'Context: "the API architecture we designed"',
    query: 'the API architecture we designed',
    primary: { entity: 'project_delta_api', count: 60 },
    diverse: [
      { entity: 'project_epsilon_api', count: 35 },
      { entity: 'api_design_patterns', count: 12 }
    ],
    primaryMessages: [
      'Delta API architecture follows hexagonal/ports-and-adapters pattern',
      'We designed Delta API with domain-driven design principles',
      'API gateway pattern chosen for Delta microservices communication',
      'Delta API versioning strategy: URL-based versioning (/v1/, /v2/)',
      'Circuit breaker pattern implemented in Delta API for resilience'
    ],
    diverseMessages: {
      'project_epsilon_api': [
        'Epsilon API architecture is more monolithic, needs refactoring',
        'Epsilon team wants to adopt Delta API patterns'
      ],
      'api_design_patterns': [
        'Studied microservices patterns book - API gateway chapter'
      ]
    }
  },

  {
    num: 58,
    icp: 'developer',
    queryType: 'context_query',
    name: 'Context: "our Docker setup for local dev"',
    query: 'our Docker setup for local dev',
    primary: { entity: 'project_gamma_docker', count: 40 },
    diverse: [
      { entity: 'devops_docker_general', count: 25 }
    ],
    primaryMessages: [
      'Gamma local dev uses Docker Compose with hot-reload volumes',
      'Our Docker setup includes Postgres, Redis, and app containers',
      'Gamma .env.local configuration mounted into containers',
      'Local dev Docker network allows inter-container communication',
      'Docker Compose profiles let devs run subset of services'
    ],
    diverseMessages: {
      'devops_docker_general': [
        'Standard Docker setup template created for all projects',
        'DevOps team maintains shared Docker base images'
      ]
    }
  },

  {
    num: 59,
    icp: 'developer',
    queryType: 'context_query',
    name: 'Context: "the database migration issue"',
    query: 'the database migration issue',
    primary: { entity: 'project_alpha_postgres', count: 55 },
    diverse: [
      { entity: 'database_migration_tools', count: 15 }
    ],
    primaryMessages: [
      'Alpha migration failed due to lock timeout on large table',
      'The database migration issue was foreign key constraint violation',
      'We had to rollback Alpha migration and fix SQL syntax error',
      'Migration downtime exceeded estimate - table rewrite took 4 hours',
      'Resolved migration issue by running in batches instead of single transaction'
    ],
    diverseMessages: {
      'database_migration_tools': [
        'Flyway migration versioning conflict resolution guide'
      ]
    }
  },

  {
    num: 60,
    icp: 'developer',
    queryType: 'context_query',
    name: 'Context: "testing approach for critical flows"',
    query: 'testing approach for critical flows',
    primary: { entity: 'project_gamma_testing', count: 45 },
    diverse: [
      { entity: 'testing_best_practices', count: 10 }
    ],
    primaryMessages: [
      'Gamma critical flows have 100% e2e test coverage requirement',
      'Our testing approach uses Playwright for user registration flow',
      'Payment processing in Gamma tested with mocked Stripe webhooks',
      'Critical flow tests run on every commit in CI pipeline',
      'Testing approach includes load testing critical paths with k6'
    ],
    diverseMessages: {
      'testing_best_practices': [
        'Article on risk-based testing for prioritizing critical flows'
      ]
    }
  },

  // Full sentence queries (5 scenarios)
  {
    num: 61,
    icp: 'developer',
    queryType: 'full_sentence',
    name: 'Sentence: "What did we decide about async/await?"',
    query: 'What did we decide about async/await?',
    primary: { entity: 'project_delta_async', count: 35 },
    diverse: [
      { entity: 'javascript_patterns', count: 20 }
    ],
    primaryMessages: [
      'Delta team decided to use async/await over Promise chains',
      'We agreed async/await improves readability in error handling',
      'Decision: top-level await allowed in Delta ES modules',
      'Async/await decision: avoid mixing with callbacks to prevent confusion',
      'Delta code review guideline: always use try/catch with async/await'
    ],
    diverseMessages: {
      'javascript_patterns': [
        'Async/await vs Promises performance comparison',
        'Best practices for error handling in async functions'
      ]
    }
  },

  {
    num: 62,
    icp: 'developer',
    queryType: 'full_sentence',
    name: 'Sentence: "How did we solve the memory leak?"',
    query: 'How did we solve the memory leak?',
    primary: { entity: 'project_alpha_memory_leak', count: 42 },
    diverse: [
      { entity: 'debugging_techniques', count: 18 }
    ],
    primaryMessages: [
      'Solved Alpha memory leak by removing circular references in event listeners',
      'Memory leak fix: switched from setInterval to setTimeout pattern',
      'We used heap snapshots to identify the leak in Alpha cache layer',
      'Root cause was unclosed database connections in Alpha background jobs',
      'Fix deployed: connection pooling properly releases connections now'
    ],
    diverseMessages: {
      'debugging_techniques': [
        'Chrome DevTools memory profiling guide',
        'Node.js memory leak detection with clinic.js'
      ]
    }
  },

  {
    num: 63,
    icp: 'developer',
    queryType: 'full_sentence',
    name: 'Sentence: "Why did we choose Postgres over MongoDB?"',
    query: 'Why did we choose Postgres over MongoDB?',
    primary: { entity: 'project_alpha_postgres', count: 55 },
    diverse: [
      { entity: 'database_comparisons', count: 22 }
    ],
    primaryMessages: [
      'Chose Postgres for Alpha because data has clear relational structure',
      'Decision: Postgres JSONB gives us NoSQL flexibility when needed',
      'We picked Postgres over MongoDB for ACID transaction guarantees',
      'Alpha team valued Postgres mature tooling and ecosystem',
      'MongoDB considered but Postgres won due to team SQL expertise'
    ],
    diverseMessages: {
      'database_comparisons': [
        'Postgres vs MongoDB benchmark results for our use case',
        'When to use relational vs document databases article'
      ]
    }
  },

  {
    num: 64,
    icp: 'developer',
    queryType: 'full_sentence',
    name: 'Sentence: "What was the CI/CD pipeline issue?"',
    query: 'What was the CI/CD pipeline issue?',
    primary: { entity: 'cicd_pipeline_failure', count: 38 },
    diverse: [
      { entity: 'ci_cd_testing', count: 28 }
    ],
    primaryMessages: [
      'CI/CD pipeline issue was Docker Hub rate limiting our builds',
      'The pipeline failure happened due to expired AWS credentials',
      'Test stage timeout increased to fix the CI/CD issue',
      'Pipeline broke when dependency registry went down',
      'Fixed by adding artifact caching to speed up builds'
    ],
    diverseMessages: {
      'ci_cd_testing': [
        'General CI/CD best practices documentation',
        'Pipeline optimization guide we\'re following'
      ]
    }
  },

  {
    num: 65,
    icp: 'developer',
    queryType: 'full_sentence',
    name: 'Sentence: "How should we handle rate limiting?"',
    query: 'How should we handle rate limiting?',
    primary: { entity: 'project_delta_api', count: 60 },
    diverse: [
      { entity: 'api_design_patterns', count: 12 }
    ],
    primaryMessages: [
      'Delta API rate limiting uses token bucket algorithm',
      'Decision: 1000 requests per hour per API key for Delta',
      'Rate limit headers included: X-RateLimit-Remaining, X-RateLimit-Reset',
      'We handle rate limiting with Redis for distributed counting',
      'Delta returns 429 Too Many Requests with Retry-After header'
    ],
    diverseMessages: {
      'api_design_patterns': [
        'Rate limiting algorithms comparison: token bucket vs leaky bucket',
        'API rate limiting best practices guide'
      ]
    }
  },

  // Vague queries (5 scenarios)
  {
    num: 66,
    icp: 'developer',
    queryType: 'vague',
    name: 'Vague: "that caching thing"',
    query: 'that caching thing',
    primary: { entity: 'project_alpha_redis', count: 50 },
    diverse: [
      { entity: 'project_beta_cache', count: 30 }
    ],
    primaryMessages: [
      'That Redis caching implementation in Alpha is working great',
      'The caching thing we discussed - Alpha cache hit rate is 92%',
      'Remember that caching optimization? Reduced Alpha load by 60%'
    ],
    diverseMessages: {
      'project_beta_cache': [
        'Beta caching needs work, not like Alpha'
      ]
    }
  },

  {
    num: 67,
    icp: 'developer',
    queryType: 'vague',
    name: 'Vague: "the deployment problem"',
    query: 'the deployment problem',
    primary: { entity: 'project_gamma_deployment', count: 44 },
    diverse: [
      { entity: 'devops_general', count: 25 }
    ],
    primaryMessages: [
      'The deployment problem in Gamma was rollback strategy missing',
      'That deployment issue we had - health checks weren\'t configured',
      'Remember the deployment problem? Blue-green deployment solved it'
    ],
    diverseMessages: {
      'devops_general': [
        'General deployment best practices we should follow'
      ]
    }
  },

  {
    num: 68,
    icp: 'developer',
    queryType: 'vague',
    name: 'Vague: "that architecture discussion"',
    query: 'that architecture discussion',
    primary: { entity: 'project_delta_api', count: 60 },
    diverse: [
      { entity: 'api_design_patterns', count: 12 }
    ],
    primaryMessages: [
      'That architecture discussion about Delta API microservices split',
      'Remember the architecture talk? We chose event-driven for Delta',
      'The architecture discussion resulted in hexagonal pattern for Delta'
    ],
    diverseMessages: {
      'api_design_patterns': [
        'General architecture pattern reference materials'
      ]
    }
  },

  {
    num: 69,
    icp: 'developer',
    queryType: 'vague',
    name: 'Vague: "the performance issue"',
    query: 'the performance issue',
    primary: { entity: 'project_alpha_performance', count: 52 },
    diverse: [
      { entity: 'optimization_general', count: 20 }
    ],
    primaryMessages: [
      'The Alpha performance issue was N+1 query in user dashboard',
      'That performance problem we fixed - added database indexes',
      'Remember the performance bottleneck? Connection pooling solved it'
    ],
    diverseMessages: {
      'optimization_general': [
        'General performance optimization techniques'
      ]
    }
  },

  {
    num: 70,
    icp: 'developer',
    queryType: 'vague',
    name: 'Vague: "the security thing"',
    query: 'the security thing',
    primary: { entity: 'project_delta_security', count: 48 },
    diverse: [
      { entity: 'security_general', count: 18 }
    ],
    primaryMessages: [
      'The security thing in Delta - implemented OAuth2 properly',
      'That security issue we addressed - SQL injection vulnerability',
      'Remember the security audit? Delta passed with one minor fix'
    ],
    diverseMessages: {
      'security_general': [
        'OWASP Top 10 security guidelines'
      ]
    }
  },

  // Clarified queries (5 scenarios)
  {
    num: 71,
    icp: 'developer',
    queryType: 'clarified',
    name: 'Clarified: "Redis for Alpha, not Beta"',
    query: 'Redis for Alpha, not Beta',
    primary: { entity: 'project_alpha_redis', count: 50 },
    diverse: [
      { entity: 'project_beta_cache', count: 30 }
    ],
    primaryMessages: [
      'Alpha Redis implementation complete - not Beta yet',
      'Redis caching in Alpha production, Beta still using Memcached',
      'Alpha team owns Redis setup, Beta migration planned Q2'
    ],
    diverseMessages: {
      'project_beta_cache': [
        'Beta caching uses Memcached, not Redis',
        'Beta Redis migration planned but not started'
      ]
    }
  },

  {
    num: 72,
    icp: 'developer',
    queryType: 'clarified',
    name: 'Clarified: "the API in Delta, not Epsilon"',
    query: 'the API in Delta, not Epsilon',
    primary: { entity: 'project_delta_api', count: 60 },
    diverse: [
      { entity: 'project_epsilon_api', count: 35 }
    ],
    primaryMessages: [
      'Delta API uses REST, Epsilon uses gRPC',
      'The API work is focused on Delta right now, Epsilon later',
      'Delta API v2 launch next month, Epsilon not ready'
    ],
    diverseMessages: {
      'project_epsilon_api': [
        'Epsilon API is separate codebase from Delta',
        'Epsilon team waiting for Delta patterns to stabilize'
      ]
    }
  },

  {
    num: 73,
    icp: 'developer',
    queryType: 'clarified',
    name: 'Clarified: "Postgres performance, not the MySQL issue"',
    query: 'Postgres performance, not the MySQL issue',
    primary: { entity: 'project_alpha_postgres', count: 55 },
    diverse: [
      { entity: 'project_beta_mysql', count: 30 }
    ],
    primaryMessages: [
      'Alpha Postgres slow query fixed with index, not MySQL',
      'Postgres optimization in Alpha reduced latency by 80%',
      'Alpha database is Postgres, Beta uses MySQL'
    ],
    diverseMessages: {
      'project_beta_mysql': [
        'Beta MySQL replication lag is separate issue',
        'MySQL in Beta has different problems than Postgres'
      ]
    }
  },

  {
    num: 74,
    icp: 'developer',
    queryType: 'clarified',
    name: 'Clarified: "Docker for Gamma local dev, not production"',
    query: 'Docker for Gamma local dev, not production',
    primary: { entity: 'project_gamma_docker', count: 40 },
    diverse: [
      { entity: 'devops_docker_general', count: 25 }
    ],
    primaryMessages: [
      'Gamma Docker Compose for local dev only, production uses k8s',
      'Docker setup is development environment, not production deployment',
      'Local Gamma Docker workflow different from production containers'
    ],
    diverseMessages: {
      'devops_docker_general': [
        'Production uses Kubernetes, not Docker Compose',
        'Docker in production vs development environments'
      ]
    }
  },

  {
    num: 75,
    icp: 'developer',
    queryType: 'clarified',
    name: 'Clarified: "testing strategy for Gamma, not general testing"',
    query: 'testing strategy for Gamma, not general testing',
    primary: { entity: 'project_gamma_testing', count: 45 },
    diverse: [
      { entity: 'testing_best_practices', count: 10 }
    ],
    primaryMessages: [
      'Gamma testing strategy is TDD with Playwright e2e tests',
      'The testing approach for Gamma specifically, not company-wide',
      'Gamma test pyramid: 70% unit, 20% integration, 10% e2e'
    ],
    diverseMessages: {
      'testing_best_practices': [
        'General testing best practices apply to all projects',
        'Testing philosophy guide is company-wide, not Gamma-specific'
      ]
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════
// AI COMPANION USER SCENARIOS (25 scenarios)
// ═══════════════════════════════════════════════════════════════════════

const companionScenarios = [
  // Single-word queries (5 scenarios)
  {
    num: 76,
    icp: 'companion',
    queryType: 'single_word',
    name: 'Single word: "anxiety"',
    query: 'anxiety',
    primary: { entity: 'anxiety_work', count: 50 },
    diverse: [
      { entity: 'anxiety_social', count: 35 },
      { entity: 'anxiety_health', count: 20 }
    ],
    primaryMessages: [
      'My work anxiety has been really bad lately with the new manager',
      'Feeling anxious about the presentation I have to give tomorrow at work',
      'The work anxiety keeps me up at night, can\'t stop thinking about deadlines',
      'My therapist said my work anxiety might be burnout',
      'Work anxiety triggered again when my boss criticized my project'
    ],
    diverseMessages: {
      'anxiety_social': [
        'Social anxiety made me cancel plans with friends again',
        'Feeling anxious about the party next weekend, too many people',
        'Social situations trigger my anxiety more than work does'
      ],
      'anxiety_health': [
        'Health anxiety flared up after that doctor appointment',
        'Can\'t stop googling symptoms, my health anxiety is spiraling'
      ]
    }
  },

  {
    num: 77,
    icp: 'companion',
    queryType: 'single_word',
    name: 'Single word: "Jennifer"',
    query: 'Jennifer',
    primary: { entity: 'therapist_jennifer', count: 55 },
    diverse: [
      { entity: 'sister_jennifer', count: 30 },
      { entity: 'ex_jennifer', count: 15 }
    ],
    primaryMessages: [
      'My therapist Jennifer helped me work through my anxiety today',
      'Jennifer thinks I should try cognitive behavioral therapy',
      'Had a breakthrough in therapy with Jennifer about my childhood',
      'Jennifer suggested I journal more to track my mood patterns',
      'My therapist Jennifer is going on vacation next week, feeling nervous'
    ],
    diverseMessages: {
      'sister_jennifer': [
        'My sister Jennifer called, she\'s getting married in June',
        'Jennifer invited me to her housewarming party',
        'Sister Jennifer doesn\'t understand my mental health struggles'
      ],
      'ex_jennifer': [
        'Saw my ex Jennifer at the coffee shop, it was awkward',
        'Still processing the breakup with Jennifer from last year'
      ]
    }
  },

  {
    num: 78,
    icp: 'companion',
    queryType: 'single_word',
    name: 'Single word: "therapy"',
    query: 'therapy',
    primary: { entity: 'therapy_sessions', count: 60 },
    diverse: [
      { entity: 'therapy_goals', count: 25 },
      { entity: 'therapy_techniques', count: 18 }
    ],
    primaryMessages: [
      'Therapy session today was intense, we talked about my family',
      'My therapy appointments are the only thing keeping me grounded',
      'Started therapy six months ago, already noticing improvements',
      'Therapy has helped me recognize my negative thought patterns',
      'Looking forward to my weekly therapy session on Thursday'
    ],
    diverseMessages: {
      'therapy_goals': [
        'My therapy goals include managing anxiety and building confidence',
        'We set new goals in therapy: practice self-compassion daily'
      ],
      'therapy_techniques': [
        'Jennifer taught me a grounding technique for panic attacks',
        'Learning mindfulness techniques in therapy has been helpful'
      ]
    }
  },

  {
    num: 79,
    icp: 'companion',
    queryType: 'single_word',
    name: 'Single word: "loneliness"',
    query: 'loneliness',
    primary: { entity: 'loneliness_feelings', count: 48 },
    diverse: [
      { entity: 'loneliness_coping', count: 22 },
      { entity: 'social_isolation', count: 15 }
    ],
    primaryMessages: [
      'The loneliness is overwhelming tonight, wish I had someone to talk to',
      'Feeling really lonely after moving to this new city',
      'Loneliness hits hardest on weekends when I\'m alone',
      'Talked to my therapist about my chronic loneliness',
      'My loneliness feels different than just being alone'
    ],
    diverseMessages: {
      'loneliness_coping': [
        'Trying new coping strategies for loneliness: joined a book club',
        'Volunteering helps with loneliness, gives me purpose'
      ],
      'social_isolation': [
        'Working from home increased my social isolation',
        'Pandemic made my isolation worse, still recovering'
      ]
    }
  },

  {
    num: 80,
    icp: 'companion',
    queryType: 'single_word',
    name: 'Single word: "depression"',
    query: 'depression',
    primary: { entity: 'depression_episodes', count: 52 },
    diverse: [
      { entity: 'depression_medication', count: 28 },
      { entity: 'depression_recovery', count: 20 }
    ],
    primaryMessages: [
      'Depression episode lasted three weeks this time, finally lifting',
      'Can barely get out of bed when depression hits this hard',
      'My depression makes everything feel pointless and heavy',
      'Talked to my doctor about my depression, might need med adjustment',
      'Depression combined with loneliness is a brutal combination'
    ],
    diverseMessages: {
      'depression_medication': [
        'Started antidepressant medication two months ago',
        'Side effects from depression meds are manageable now'
      ],
      'depression_recovery': [
        'Small wins in depression recovery: showered today',
        'Recovery from depression is not linear, had a setback'
      ]
    }
  },

  // Context queries (5 scenarios)
  {
    num: 81,
    icp: 'companion',
    queryType: 'context_query',
    name: 'Context: "my work anxiety"',
    query: 'my work anxiety',
    primary: { entity: 'anxiety_work', count: 50 },
    diverse: [
      { entity: 'anxiety_social', count: 35 }
    ],
    primaryMessages: [
      'My work anxiety is specifically about performance reviews',
      'The work anxiety gets worse on Sunday nights before the week',
      'Work-related anxiety triggers include emails from my boss',
      'My work anxiety improved after I set better boundaries',
      'Workplace anxiety tied to impostor syndrome, therapist says'
    ],
    diverseMessages: {
      'anxiety_social': [
        'Social anxiety is separate from my work stress',
        'My social anxiety affects friendships, work anxiety affects career'
      ]
    }
  },

  {
    num: 82,
    icp: 'companion',
    queryType: 'context_query',
    name: 'Context: "what Jennifer said about my childhood"',
    query: 'what Jennifer said about my childhood',
    primary: { entity: 'therapist_jennifer', count: 55 },
    diverse: [
      { entity: 'childhood_trauma', count: 30 }
    ],
    primaryMessages: [
      'Jennifer said my childhood attachment issues affect my relationships now',
      'My therapist Jennifer connected my anxiety to childhood experiences',
      'What Jennifer explained about my childhood patterns made sense',
      'Jennifer thinks my childhood emotional neglect impacts my self-worth',
      'Therapist Jennifer helped me see how my childhood shaped my fears'
    ],
    diverseMessages: {
      'childhood_trauma': [
        'Processing childhood trauma is hard but necessary work',
        'My childhood experiences with my parents still affect me'
      ]
    }
  },

  {
    num: 83,
    icp: 'companion',
    queryType: 'context_query',
    name: 'Context: "how I felt about the breakup"',
    query: 'how I felt about the breakup',
    primary: { entity: 'ex_jennifer', count: 15 },
    diverse: [
      { entity: 'relationship_grief', count: 25 }
    ],
    primaryMessages: [
      'The breakup with Jennifer devastated me, still processing it',
      'How I felt about the breakup: relieved but also heartbroken',
      'Breakup grief is different than I expected, comes in waves',
      'My feelings about the breakup evolved from anger to acceptance',
      'The breakup triggered my abandonment fears from childhood'
    ],
    diverseMessages: {
      'relationship_grief': [
        'Grieving the relationship is taking longer than I thought',
        'Relationship loss feels like mourning a death sometimes'
      ]
    }
  },

  {
    num: 84,
    icp: 'companion',
    queryType: 'context_query',
    name: 'Context: "my therapy goals for this year"',
    query: 'my therapy goals for this year',
    primary: { entity: 'therapy_goals', count: 25 },
    diverse: [
      { entity: 'therapy_sessions', count: 60 }
    ],
    primaryMessages: [
      'My therapy goals include managing anxiety without medication',
      'This year in therapy I want to work on self-compassion',
      'Therapy goals: improve relationships, reduce social isolation',
      'My main therapy goal is healing childhood trauma',
      'Set ambitious therapy goals but being gentle with myself'
    ],
    diverseMessages: {
      'therapy_sessions': [
        'Regular therapy sessions help me work toward my goals',
        'In therapy we review goals monthly to track progress'
      ]
    }
  },

  {
    num: 85,
    icp: 'companion',
    queryType: 'context_query',
    name: 'Context: "coping with loneliness"',
    query: 'coping with loneliness',
    primary: { entity: 'loneliness_coping', count: 22 },
    diverse: [
      { entity: 'loneliness_feelings', count: 48 }
    ],
    primaryMessages: [
      'Coping with loneliness by reaching out to friends more often',
      'My loneliness coping strategies: journaling and calling family',
      'Learning healthy ways of coping with loneliness in therapy',
      'Coping mechanisms for loneliness include volunteering and hobbies',
      'Finding community helped me cope with chronic loneliness'
    ],
    diverseMessages: {
      'loneliness_feelings': [
        'The feelings of loneliness are still there despite coping efforts',
        'Loneliness persists but I\'m managing it better now'
      ]
    }
  },

  // Full sentence queries (5 scenarios)
  {
    num: 86,
    icp: 'companion',
    queryType: 'full_sentence',
    name: 'Sentence: "What did my therapist say about boundaries?"',
    query: 'What did my therapist say about boundaries?',
    primary: { entity: 'therapist_jennifer', count: 55 },
    diverse: [
      { entity: 'therapy_techniques', count: 18 }
    ],
    primaryMessages: [
      'Jennifer said boundaries are self-care, not selfishness',
      'My therapist explained that boundaries protect my energy',
      'Jennifer taught me how to set boundaries without guilt',
      'Therapist said poor boundaries led to my burnout',
      'Jennifer emphasized boundaries are necessary for healthy relationships'
    ],
    diverseMessages: {
      'therapy_techniques': [
        'Boundary-setting techniques I learned in therapy',
        'Practicing boundary communication skills'
      ]
    }
  },

  {
    num: 87,
    icp: 'companion',
    queryType: 'full_sentence',
    name: 'Sentence: "How am I doing with my depression recovery?"',
    query: 'How am I doing with my depression recovery?',
    primary: { entity: 'depression_recovery', count: 20 },
    diverse: [
      { entity: 'depression_episodes', count: 52 }
    ],
    primaryMessages: [
      'Depression recovery progress: more good days than bad now',
      'I\'m doing better with depression, small consistent improvements',
      'Recovery from depression is slow but I\'m making progress',
      'My depression recovery includes celebrating tiny victories',
      'Tracking my depression recovery helps me see the pattern'
    ],
    diverseMessages: {
      'depression_episodes': [
        'Still have depression episodes but they\'re shorter now',
        'Episodes are less frequent during my recovery journey'
      ]
    }
  },

  {
    num: 88,
    icp: 'companion',
    queryType: 'full_sentence',
    name: 'Sentence: "Why do I feel so lonely even around people?"',
    query: 'Why do I feel so lonely even around people?',
    primary: { entity: 'loneliness_feelings', count: 48 },
    diverse: [
      { entity: 'social_isolation', count: 15 }
    ],
    primaryMessages: [
      'Loneliness around people means lack of genuine connection',
      'I can feel lonely in a crowd because no one truly knows me',
      'The loneliness isn\'t about physical presence, it\'s emotional',
      'My therapist explained loneliness is about feeling unseen',
      'Surrounded by people but still lonely - that\'s my everyday experience'
    ],
    diverseMessages: {
      'social_isolation': [
        'Social isolation is physical, loneliness is emotional',
        'Isolation made my loneliness worse but they\'re different'
      ]
    }
  },

  {
    num: 89,
    icp: 'companion',
    queryType: 'full_sentence',
    name: 'Sentence: "What helped me through the anxiety attack?"',
    query: 'What helped me through the anxiety attack?',
    primary: { entity: 'anxiety_coping', count: 32 },
    diverse: [
      { entity: 'anxiety_work', count: 50 }
    ],
    primaryMessages: [
      'Grounding technique Jennifer taught me helped through the attack',
      'Deep breathing and counting helped me survive the anxiety attack',
      'What helped: naming 5 things I can see, 4 I can touch',
      'The anxiety attack passed when I used my coping tools',
      'Progressive muscle relaxation helped me calm down during attack'
    ],
    diverseMessages: {
      'anxiety_work': [
        'Work anxiety sometimes escalates to panic attacks',
        'Workplace stress can trigger my anxiety attacks'
      ]
    }
  },

  {
    num: 90,
    icp: 'companion',
    queryType: 'full_sentence',
    name: 'Sentence: "How do I know if I\'m making progress in therapy?"',
    query: 'How do I know if I\'m making progress in therapy?',
    primary: { entity: 'therapy_sessions', count: 60 },
    diverse: [
      { entity: 'therapy_goals', count: 25 }
    ],
    primaryMessages: [
      'Therapy progress shows in how I handle difficult emotions now',
      'I know therapy is working because I catch my negative thoughts',
      'Progress in therapy: I set boundaries without excessive guilt',
      'My relationships improving is a sign therapy is helping',
      'Therapy progress is slow but I notice I\'m more self-aware'
    ],
    diverseMessages: {
      'therapy_goals': [
        'Measuring progress against my therapy goals monthly',
        'Goals help me track concrete progress in therapy'
      ]
    }
  },

  // Vague queries (5 scenarios)
  {
    num: 91,
    icp: 'companion',
    queryType: 'vague',
    name: 'Vague: "that conversation"',
    query: 'that conversation',
    primary: { entity: 'therapist_jennifer', count: 55 },
    diverse: [
      { entity: 'therapy_sessions', count: 60 }
    ],
    primaryMessages: [
      'That conversation with Jennifer about my mother was intense',
      'Remember that therapy conversation about attachment styles?',
      'The conversation in therapy yesterday changed my perspective'
    ],
    diverseMessages: {
      'therapy_sessions': [
        'Therapy conversations are always meaningful',
        'Our sessions involve deep, transformative conversations'
      ]
    }
  },

  {
    num: 92,
    icp: 'companion',
    queryType: 'vague',
    name: 'Vague: "how I was feeling"',
    query: 'how I was feeling',
    primary: { entity: 'depression_episodes', count: 52 },
    diverse: [
      { entity: 'loneliness_feelings', count: 48 }
    ],
    primaryMessages: [
      'How I was feeling last week: completely overwhelmed and numb',
      'My feelings were all over the place during that episode',
      'Couldn\'t articulate how I was feeling, just knew it was dark'
    ],
    diverseMessages: {
      'loneliness_feelings': [
        'Loneliness adds to how I feel during depression',
        'My feelings of isolation compound the depression'
      ]
    }
  },

  {
    num: 93,
    icp: 'companion',
    queryType: 'vague',
    name: 'Vague: "what we discussed"',
    query: 'what we discussed',
    primary: { entity: 'therapy_sessions', count: 60 },
    diverse: [
      { entity: 'therapy_goals', count: 25 }
    ],
    primaryMessages: [
      'What we discussed in therapy: my fear of abandonment',
      'The things we talked about in session really resonated',
      'What we discussed about my relationship patterns made sense'
    ],
    diverseMessages: {
      'therapy_goals': [
        'We discussed my goals and adjusted them',
        'Goal-setting was part of what we discussed'
      ]
    }
  },

  {
    num: 94,
    icp: 'companion',
    queryType: 'vague',
    name: 'Vague: "that difficult moment"',
    query: 'that difficult moment',
    primary: { entity: 'anxiety_attack', count: 28 },
    diverse: [
      { entity: 'depression_episodes', count: 52 }
    ],
    primaryMessages: [
      'That difficult moment when I had the panic attack at work',
      'The hard moment during my anxiety attack in the grocery store',
      'That difficult time when my anxiety peaked and I couldn\'t breathe'
    ],
    diverseMessages: {
      'depression_episodes': [
        'Depression episodes create many difficult moments',
        'Difficult times during my depression are different than anxiety'
      ]
    }
  },

  {
    num: 95,
    icp: 'companion',
    queryType: 'vague',
    name: 'Vague: "the breakthrough"',
    query: 'the breakthrough',
    primary: { entity: 'therapy_breakthrough', count: 35 },
    diverse: [
      { entity: 'therapy_sessions', count: 60 }
    ],
    primaryMessages: [
      'The breakthrough in therapy was realizing my patterns',
      'Had a major breakthrough about why I sabotage relationships',
      'That breakthrough moment when everything clicked about my anxiety'
    ],
    diverseMessages: {
      'therapy_sessions': [
        'Therapy sessions sometimes lead to breakthroughs',
        'Not every session has a breakthrough but they build up'
      ]
    }
  },

  // Clarified queries (5 scenarios)
  {
    num: 96,
    icp: 'companion',
    queryType: 'clarified',
    name: 'Clarified: "anxiety at work, not social anxiety"',
    query: 'anxiety at work, not social anxiety',
    primary: { entity: 'anxiety_work', count: 50 },
    diverse: [
      { entity: 'anxiety_social', count: 35 }
    ],
    primaryMessages: [
      'Work anxiety is about performance, social anxiety is about judgment',
      'My workplace anxiety is separate from my social fears',
      'Work-specific anxiety triggers are different than social ones'
    ],
    diverseMessages: {
      'anxiety_social': [
        'Social anxiety affects my personal life differently',
        'My social fears are about parties, work fears are about failure'
      ]
    }
  },

  {
    num: 97,
    icp: 'companion',
    queryType: 'clarified',
    name: 'Clarified: "Jennifer my therapist, not my sister"',
    query: 'Jennifer my therapist, not my sister',
    primary: { entity: 'therapist_jennifer', count: 55 },
    diverse: [
      { entity: 'sister_jennifer', count: 30 }
    ],
    primaryMessages: [
      'My therapist Jennifer helps me process emotions professionally',
      'Jennifer the therapist understands me better than my sister does',
      'Therapy Jennifer is trained to help, sister Jennifer judges me'
    ],
    diverseMessages: {
      'sister_jennifer': [
        'My sister Jennifer doesn\'t get my mental health struggles',
        'Sister Jennifer is supportive but not trained like my therapist'
      ]
    }
  },

  {
    num: 98,
    icp: 'companion',
    queryType: 'clarified',
    name: 'Clarified: "loneliness feelings, not isolation"',
    query: 'loneliness feelings, not isolation',
    primary: { entity: 'loneliness_feelings', count: 48 },
    diverse: [
      { entity: 'social_isolation', count: 15 }
    ],
    primaryMessages: [
      'Loneliness is emotional, isolation is physical - I mean the feeling',
      'My feelings of loneliness persist even when not isolated',
      'Loneliness is internal, isolation is external circumstance'
    ],
    diverseMessages: {
      'social_isolation': [
        'Social isolation during pandemic was forced',
        'Isolation contributed to loneliness but they\'re different'
      ]
    }
  },

  {
    num: 99,
    icp: 'companion',
    queryType: 'clarified',
    name: 'Clarified: "depression medication, not therapy techniques"',
    query: 'depression medication, not therapy techniques',
    primary: { entity: 'depression_medication', count: 28 },
    diverse: [
      { entity: 'therapy_techniques', count: 18 }
    ],
    primaryMessages: [
      'Depression medication questions are for my psychiatrist',
      'Medication management is separate from talk therapy techniques',
      'My antidepressants are medical, therapy techniques are behavioral'
    ],
    diverseMessages: {
      'therapy_techniques': [
        'Therapy techniques complement medication but are different',
        'Jennifer teaches me techniques, doctor manages medication'
      ]
    }
  },

  {
    num: 100,
    icp: 'companion',
    queryType: 'clarified',
    name: 'Clarified: "therapy goals, not just general sessions"',
    query: 'therapy goals, not just general sessions',
    primary: { entity: 'therapy_goals', count: 25 },
    diverse: [
      { entity: 'therapy_sessions', count: 60 }
    ],
    primaryMessages: [
      'My specific therapy goals guide what we work on in sessions',
      'Goals for therapy this year are concrete and measurable',
      'Therapy goals help me track progress beyond just attending'
    ],
    diverseMessages: {
      'therapy_sessions': [
        'Sessions are where we work toward goals',
        'General therapy sessions support goal achievement'
      ]
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO GENERATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate candidates for a scenario
 *
 * FIXED: Now uses diverse COMPETING entities instead of all using primary entity
 *
 * Creates realistic test scenarios where:
 * - Primary entity messages should win (but aren't guaranteed to)
 * - Competitor entities can plausibly compete
 * - Tests can actually FAIL if MMR doesn't work correctly
 */
function generateCandidates(scenario) {
  const candidates = [];

  // ═══════════════════════════════════════════════════════════════════════
  // PRIMARY ENTITY (Expected Winner)
  // ═══════════════════════════════════════════════════════════════════════

  // Multiple messages about the primary entity
  // Should have BEST distance on average, with small variance for realism
  // Base range: 0.20-0.27, with random variance ±0.02
  // Effective range with randomness: 0.18-0.29 (slight overlap for realistic testing)
  scenario.primaryMessages.forEach((msg, idx) => {
    const baseDistance = 0.20 + idx * 0.014;  // Base: 0.20-0.27
    const randomVariance = (Math.random() - 0.5) * 0.04;  // ±0.02 variance

    candidates.push({
      content: msg,
      entity: scenario.primary.entity,  // ✅ This should win (best average distance)
      embedding: genEmb(0.88 - idx * 0.015, 0.78),
      distance: baseDistance + randomVariance,  // With variance: 0.18-0.29
      platform: scenario.primary.platform || 'chatgpt',
      timestamp: Date.now() - (idx + 1) * 86400000,
      relevance: 'high',
      ground_truth: 'primary'  // Mark for analysis
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DIVERSE ENTITY MESSAGES (Different Entities - Competition)
  // ═══════════════════════════════════════════════════════════════════════

  // Use the ORIGINAL diverse entity structure from scenario
  // These are DIFFERENT entities that compete with primary
  // CRITICAL: Distances OVERLAP with primary to force MMR to use diversity logic
  scenario.diverse.forEach((diverse, diverseIdx) => {
    const messages = scenario.diverseMessages[diverse.entity];

    messages.forEach((msg, msgIdx) => {
      // High similarity competitors: Distance range 0.23-0.31 (close to primary, overlaps slightly)
      // Medium similarity competitors: Distance range 0.30-0.40 (clearly worse)
      // This creates realistic competition where primary usually wins, but not always
      let baseDistance, distanceSpread;
      if (diverseIdx === 0) {
        // High similarity competitor - close but usually loses to primary
        // Sometimes can beat primary due to randomness (creates 5-10% failure rate)
        baseDistance = 0.23;
        distanceSpread = 0.013;  // Range: 0.23-0.31
      } else {
        // Medium similarity competitor - clearly worse, should almost never win
        baseDistance = 0.30;
        distanceSpread = 0.016;  // Range: 0.30-0.40
      }

      // Add moderate random noise to create realistic variance (±0.025)
      // This allows competitors to occasionally beat primary entity (5-10% failure rate)
      const diverseDistance = baseDistance + msgIdx * distanceSpread + (Math.random() - 0.5) * 0.05;

      candidates.push({
        content: msg,
        entity: diverse.entity,  // ✅ Different entity (competitor)
        embedding: genEmb(0.82 - diverseIdx * 0.04 - msgIdx * 0.015, 0.68),
        distance: diverseDistance,
        platform: scenario.primary.platform || 'chatgpt',
        timestamp: Date.now() - (diverseIdx + msgIdx + 5) * 86400000,
        relevance: diverseIdx === 0 ? 'high' : 'medium',
        ground_truth: diverseIdx === 0 ? 'competitor_high' : 'competitor_medium'
      });
    });
  });

  // Shuffle to avoid position bias (MMR shouldn't rely on input order)
  return shuffleArray(candidates);
}

/**
 * Shuffle array using Fisher-Yates algorithm
 */
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Export all scenarios for Batch 2
 */
function generateBatch2Scenarios() {
  const allScenarios = [...developerScenarios, ...companionScenarios];

  return allScenarios.map(scenario => ({
    num: scenario.num,
    icp: scenario.icp,
    queryType: scenario.queryType,
    name: scenario.name,
    query: scenario.query,
    expectedPrimary: scenario.primary.entity,
    expectedDiverse: scenario.diverse.map(d => d.entity),
    candidates: generateCandidates(scenario)
  }));
}

// Export for use in test runner
export { generateBatch2Scenarios, developerScenarios, companionScenarios };

// If run directly, output JSON
if (import.meta.url === `file://${process.argv[1]}`) {
  const scenarios = generateBatch2Scenarios();
  console.log(JSON.stringify(scenarios, null, 2));
}
