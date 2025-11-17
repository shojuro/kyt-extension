/**
 * Batch 7: Cross-Platform Disambiguation (50 scenarios)
 *
 * Tests K.Y.T.'s CORE VALUE PROP: Memory across ChatGPT + Claude
 *
 * Customized for K.Y.T. ICPs:
 * - 25 Developer Power User scenarios
 * - 25 AI Companion User scenarios
 *
 * Tests:
 * - Same topic discussed in both platforms
 * - Entity mentioned in ChatGPT, queried in Claude
 * - Clarifying which conversation happened where
 * - Platform affinity vs recency trade-offs
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
 * @param {number} relevance - How relevant to topic (0-1)
 * @param {number} diversity - How different from other embeddings (0-1)
 * @param {string} platform - 'chatgpt' or 'claude' (affects embedding slightly)
 */
function genEmb(relevance, diversity = 0.5, platform = 'chatgpt') {
  const base = [];
  const platformOffset = platform === 'claude' ? 0.02 : 0; // Smaller offset for realistic behavior

  for (let i = 0; i < 10; i++) {
    // Much more random variation to match real embedding spread
    if (i < 3) {
      // Relevance components - much weaker signal
      base.push((relevance + platformOffset) * (0.3 + Math.random() * 0.2));
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
  // Same topic, both platforms (10 scenarios)
  {
    num: 301,
    icp: 'developer',
    crossPlatformType: 'same_topic_both',
    name: 'React architecture - discussed in both ChatGPT and Claude',
    query: 'the React architecture',
    queryPlatform: 'claude',
    primary: { entity: 'claude_project_alpha_react', count: 5, platform: 'claude', daysAgo: 1 },
    diverse: [
      { entity: 'chatgpt_project_alpha_react', count: 3, platform: 'chatgpt', daysAgo: 3 },
      { entity: 'chatgpt_react_tutorial', count: 2, platform: 'chatgpt', daysAgo: 7 }
    ],
    primaryMessages: [
      '[Claude] Project Alpha React architecture uses component composition pattern',
      '[Claude] We decided on context API over Redux for Alpha yesterday',
      '[Claude] Alpha React components follow atomic design methodology',
      '[Claude] Performance optimization: React.memo for expensive renders in Alpha',
      '[Claude] Alpha React structure: features/ and shared/ directories'
    ],
    diverseMessages: {
      'chatgpt_project_alpha_react': [
        '[ChatGPT] Discussed Alpha React state management 3 days ago',
        '[ChatGPT] Initial Alpha React architecture brainstorming session',
        '[ChatGPT] Alpha component hierarchy design in ChatGPT'
      ],
      'chatgpt_react_tutorial': [
        '[ChatGPT] Read React hooks tutorial last week',
        '[ChatGPT] General React patterns, not project-specific'
      ]
    },
    expectedBehavior: 'Should prefer Claude (query platform + recency)'
  },

  {
    num: 302,
    icp: 'developer',
    crossPlatformType: 'same_topic_both',
    name: 'Async/await decision - ChatGPT has more context',
    query: 'async/await decision',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_async_decision', count: 8, platform: 'chatgpt', daysAgo: 2 },
    diverse: [
      { entity: 'claude_async_mention', count: 2, platform: 'claude', daysAgo: 1 },
      { entity: 'chatgpt_javascript_patterns', count: 3, platform: 'chatgpt', daysAgo: 5 }
    ],
    primaryMessages: [
      '[ChatGPT] We decided async/await over Promises for Delta API',
      '[ChatGPT] Async/await decision: always use try/catch for errors',
      '[ChatGPT] Team agreed: top-level await allowed in ES modules',
      '[ChatGPT] Async/await improves readability vs .then() chains',
      '[ChatGPT] Decision documented: avoid mixing async/await with callbacks',
      '[ChatGPT] Code review guideline added for async/await usage',
      '[ChatGPT] Async/await performance benchmarked - negligible difference',
      '[ChatGPT] Migration plan from Promises to async/await in Delta'
    ],
    diverseMessages: {
      'claude_async_mention': [
        '[Claude] Mentioned async/await briefly yesterday',
        '[Claude] Quick question about async/await syntax'
      ],
      'chatgpt_javascript_patterns': [
        '[ChatGPT] JavaScript design patterns discussion',
        '[ChatGPT] Module patterns and closures',
        '[ChatGPT] Functional programming in JS'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (more mentions despite being older)'
  },

  {
    num: 303,
    icp: 'developer',
    crossPlatformType: 'same_topic_both',
    name: 'Database migration - split across platforms',
    query: 'database migration issue',
    queryPlatform: 'chatgpt',
    primary: { entity: 'claude_alpha_migration', count: 6, platform: 'claude', daysAgo: 1 },
    diverse: [
      { entity: 'chatgpt_migration_tools', count: 3, platform: 'chatgpt', daysAgo: 4 },
      { entity: 'chatgpt_postgres_general', count: 2, platform: 'chatgpt', daysAgo: 6 }
    ],
    primaryMessages: [
      '[Claude] Alpha migration failed yesterday - lock timeout on users table',
      '[Claude] Resolved migration by batching the updates instead',
      '[Claude] Database migration issue was foreign key constraint violation',
      '[Claude] Had to rollback Alpha migration due to syntax error',
      '[Claude] Migration took 4 hours - longer than estimated',
      '[Claude] Successfully deployed migration fix this morning'
    ],
    diverseMessages: {
      'chatgpt_migration_tools': [
        '[ChatGPT] Flyway vs Liquibase comparison 4 days ago',
        '[ChatGPT] Migration best practices discussion',
        '[ChatGPT] Zero-downtime migration strategies'
      ],
      'chatgpt_postgres_general': [
        '[ChatGPT] General Postgres performance tuning',
        '[ChatGPT] Index optimization strategies'
      ]
    },
    expectedBehavior: 'Should prefer Claude (query from ChatGPT but recent issue in Claude)'
  },

  {
    num: 304,
    icp: 'developer',
    crossPlatformType: 'same_topic_both',
    name: 'Docker setup - ChatGPT for initial, Claude for refinement',
    query: 'Docker setup for local dev',
    queryPlatform: 'claude',
    primary: { entity: 'claude_gamma_docker', count: 4, platform: 'claude', daysAgo: 1 },
    diverse: [
      { entity: 'chatgpt_docker_initial', count: 5, platform: 'chatgpt', daysAgo: 7 },
      { entity: 'chatgpt_devops_general', count: 2, platform: 'chatgpt', daysAgo: 10 }
    ],
    primaryMessages: [
      '[Claude] Refined Gamma Docker setup yesterday - added hot reload',
      '[Claude] Docker Compose now includes Postgres and Redis for Gamma',
      '[Claude] Local dev Docker network configuration optimized',
      '[Claude] Volume mounts fixed for .env.local in Gamma containers'
    ],
    diverseMessages: {
      'chatgpt_docker_initial': [
        '[ChatGPT] Initial Gamma Docker setup brainstorming last week',
        '[ChatGPT] Dockerfile multi-stage builds discussion',
        '[ChatGPT] Docker Compose basic structure for Gamma',
        '[ChatGPT] Container networking concepts',
        '[ChatGPT] Docker volumes and bind mounts explanation'
      ],
      'chatgpt_devops_general': [
        '[ChatGPT] General DevOps best practices',
        '[ChatGPT] CI/CD pipeline discussion'
      ]
    },
    expectedBehavior: 'Should prefer Claude (most recent refinements)'
  },

  {
    num: 305,
    icp: 'developer',
    crossPlatformType: 'same_topic_both',
    name: 'API rate limiting - Claude initial, ChatGPT implementation',
    query: 'rate limiting implementation',
    queryPlatform: 'chatgpt',
    primary: { entity: 'chatgpt_delta_ratelimit', count: 7, platform: 'chatgpt', daysAgo: 1 },
    diverse: [
      { entity: 'claude_ratelimit_design', count: 3, platform: 'claude', daysAgo: 5 },
      { entity: 'chatgpt_api_patterns', count: 2, platform: 'chatgpt', daysAgo: 8 }
    ],
    primaryMessages: [
      '[ChatGPT] Implemented Delta rate limiting with token bucket algorithm',
      '[ChatGPT] Rate limit: 1000 requests/hour per API key in production',
      '[ChatGPT] Redis used for distributed rate limit counting',
      '[ChatGPT] Rate limit headers: X-RateLimit-Remaining, X-RateLimit-Reset',
      '[ChatGPT] Returns 429 Too Many Requests with Retry-After header',
      '[ChatGPT] Rate limiter tested under load - handles 10k req/sec',
      '[ChatGPT] Deployed rate limiting to Delta staging yesterday'
    ],
    diverseMessages: {
      'claude_ratelimit_design': [
        '[Claude] Designed rate limiting strategy 5 days ago',
        '[Claude] Token bucket vs leaky bucket comparison',
        '[Claude] Rate limit algorithm selection rationale'
      ],
      'chatgpt_api_patterns': [
        '[ChatGPT] General API design patterns',
        '[ChatGPT] REST vs GraphQL discussion'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (query platform + implementation details)'
  },

  {
    num: 306,
    icp: 'developer',
    crossPlatformType: 'same_topic_both',
    name: 'Testing strategy - evolved across both platforms',
    query: 'Gamma testing approach',
    queryPlatform: 'claude',
    primary: { entity: 'claude_gamma_testing', count: 5, platform: 'claude', daysAgo: 2 },
    diverse: [
      { entity: 'chatgpt_testing_philosophy', count: 4, platform: 'chatgpt', daysAgo: 10 },
      { entity: 'claude_playwright_setup', count: 3, platform: 'claude', daysAgo: 3 }
    ],
    primaryMessages: [
      '[Claude] Gamma testing strategy: 70% unit, 20% integration, 10% e2e',
      '[Claude] Adopted TDD for Gamma critical flows',
      '[Claude] Gamma test coverage increased to 85% this week',
      '[Claude] E2e tests with Playwright for user registration flow',
      '[Claude] Mutation testing revealed gaps in Gamma test suite'
    ],
    diverseMessages: {
      'chatgpt_testing_philosophy': [
        '[ChatGPT] Testing pyramid vs testing trophy debate',
        '[ChatGPT] TDD principles and benefits discussion',
        '[ChatGPT] When to write integration vs unit tests',
        '[ChatGPT] General testing best practices'
      ],
      'claude_playwright_setup': [
        '[Claude] Playwright configuration for Gamma',
        '[Claude] E2e test fixtures and page objects',
        '[Claude] Playwright debugging techniques'
      ]
    },
    expectedBehavior: 'Should prefer Claude (query platform + recent strategy)'
  },

  {
    num: 307,
    icp: 'developer',
    crossPlatformType: 'same_topic_both',
    name: 'Redis caching - ChatGPT design, Claude troubleshooting',
    query: 'Redis caching problem',
    queryPlatform: 'claude',
    primary: { entity: 'claude_alpha_redis_issue', count: 6, platform: 'claude', daysAgo: 0 },
    diverse: [
      { entity: 'chatgpt_redis_design', count: 8, platform: 'chatgpt', daysAgo: 14 },
      { entity: 'claude_redis_general', count: 2, platform: 'claude', daysAgo: 7 }
    ],
    primaryMessages: [
      '[Claude] Alpha Redis memory usage spiked to 8GB today - investigating',
      '[Claude] Redis caching issue: TTL not expiring properly',
      '[Claude] Found memory leak in Redis connection pooling',
      '[Claude] Fixed by implementing proper connection cleanup',
      '[Claude] Redis cluster rebalanced - memory usage back to normal',
      '[Claude] Added monitoring alerts for Redis memory spikes'
    ],
    diverseMessages: {
      'chatgpt_redis_design': [
        '[ChatGPT] Designed Alpha Redis caching strategy 2 weeks ago',
        '[ChatGPT] Write-through caching pattern for Alpha',
        '[ChatGPT] Cache invalidation using pub/sub',
        '[ChatGPT] Redis data structures: hashes vs sets',
        '[ChatGPT] Alpha cache hit rate optimization',
        '[ChatGPT] Redis Cluster vs Sentinel decision',
        '[ChatGPT] Initial Redis configuration for Alpha',
        '[ChatGPT] TTL strategy: 1 hour for user sessions'
      ],
      'claude_redis_general': [
        '[Claude] Redis best practices review',
        '[Claude] Redis persistence options'
      ]
    },
    expectedBehavior: 'Should prefer Claude (recent troubleshooting today)'
  },

  {
    num: 308,
    icp: 'developer',
    crossPlatformType: 'same_topic_both',
    name: 'Postgres optimization - both platforms equally',
    query: 'Postgres performance',
    queryPlatform: 'chatgpt',
    primary: { entity: 'chatgpt_alpha_postgres', count: 5, platform: 'chatgpt', daysAgo: 2 },
    diverse: [
      { entity: 'claude_postgres_indexes', count: 5, platform: 'claude', daysAgo: 2 },
      { entity: 'chatgpt_database_general', count: 3, platform: 'chatgpt', daysAgo: 8 }
    ],
    primaryMessages: [
      '[ChatGPT] Alpha Postgres slow query fixed with composite index',
      '[ChatGPT] Query performance improved from 2s to 50ms',
      '[ChatGPT] Connection pooling increased max_connections to 200',
      '[ChatGPT] Postgres vacuum analyze scheduled nightly for Alpha',
      '[ChatGPT] Read replica added for Alpha analytics queries'
    ],
    diverseMessages: {
      'claude_postgres_indexes': [
        '[Claude] Analyzed Alpha missing indexes 2 days ago',
        '[Claude] B-tree vs GIN index selection for JSONB',
        '[Claude] Postgres EXPLAIN ANALYZE for slow queries',
        '[Claude] Index maintenance and bloat monitoring',
        '[Claude] Partial indexes for Alpha filtering patterns'
      ],
      'chatgpt_database_general': [
        '[ChatGPT] Database normalization discussion',
        '[ChatGPT] ACID properties explanation',
        '[ChatGPT] SQL vs NoSQL trade-offs'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (query platform + equal recency)'
  },

  {
    num: 309,
    icp: 'developer',
    crossPlatformType: 'same_topic_both',
    name: 'CI/CD pipeline - Claude setup, ChatGPT debugging',
    query: 'CI pipeline failure',
    queryPlatform: 'chatgpt',
    primary: { entity: 'chatgpt_cicd_debug', count: 6, platform: 'chatgpt', daysAgo: 0 },
    diverse: [
      { entity: 'claude_cicd_setup', count: 4, platform: 'claude', daysAgo: 20 },
      { entity: 'chatgpt_devops_general', count: 2, platform: 'chatgpt', daysAgo: 15 }
    ],
    primaryMessages: [
      '[ChatGPT] CI pipeline failing today - Docker Hub rate limit hit',
      '[ChatGPT] Pipeline issue: test stage timeout after 30 minutes',
      '[ChatGPT] Fixed by adding Docker registry caching',
      '[ChatGPT] Pipeline now completes in 12 minutes vs 35 before',
      '[ChatGPT] Added retry logic for flaky integration tests',
      '[ChatGPT] CI failure notifications improved in Slack'
    ],
    diverseMessages: {
      'claude_cicd_setup': [
        '[Claude] Initial CI/CD pipeline setup 3 weeks ago',
        '[Claude] GitHub Actions workflow configuration',
        '[Claude] Multi-stage Docker builds for CI',
        '[Claude] Test parallelization strategy'
      ],
      'chatgpt_devops_general': [
        '[ChatGPT] DevOps best practices overview',
        '[ChatGPT] Infrastructure as code discussion'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (query platform + debugging today)'
  },

  {
    num: 310,
    icp: 'developer',
    crossPlatformType: 'same_topic_both',
    name: 'Microservices architecture - long discussion in Claude',
    query: 'microservices design',
    queryPlatform: 'claude',
    primary: { entity: 'claude_microservices_deep', count: 12, platform: 'claude', daysAgo: 3 },
    diverse: [
      { entity: 'chatgpt_microservices_intro', count: 3, platform: 'chatgpt', daysAgo: 1 },
      { entity: 'claude_api_gateway', count: 4, platform: 'claude', daysAgo: 4 }
    ],
    primaryMessages: [
      '[Claude] Delta microservices architecture: event-driven design',
      '[Claude] Service boundaries defined by domain-driven design',
      '[Claude] Inter-service communication: async messaging with RabbitMQ',
      '[Claude] Microservices resilience: circuit breaker pattern',
      '[Claude] Data consistency: saga pattern for distributed transactions',
      '[Claude] Service discovery with Consul for Delta services',
      '[Claude] Monitoring microservices: distributed tracing with Jaeger',
      '[Claude] Delta deployment: independent service deployments',
      '[Claude] API gateway handles authentication and routing',
      '[Claude] Microservices testing strategy: contract testing',
      '[Claude] Database per service vs shared database decision',
      '[Claude] Eventual consistency trade-offs in Delta architecture'
    ],
    diverseMessages: {
      'chatgpt_microservices_intro': [
        '[ChatGPT] Monolith vs microservices discussion yesterday',
        '[ChatGPT] When to use microservices architecture',
        '[ChatGPT] Microservices challenges and benefits'
      ],
      'claude_api_gateway': [
        '[Claude] API gateway pattern for microservices',
        '[Claude] Gateway handles rate limiting and auth',
        '[Claude] Kong vs custom gateway comparison',
        '[Claude] Gateway routing configuration'
      ]
    },
    expectedBehavior: 'Should prefer Claude (query platform + depth of discussion)'
  },

  // ChatGPT mention, Claude query (8 scenarios)
  {
    num: 311,
    icp: 'developer',
    crossPlatformType: 'cross_platform_query',
    name: 'Mentioned in ChatGPT, queried in Claude - recent',
    query: 'GraphQL schema design',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_graphql_schema', count: 5, platform: 'chatgpt', daysAgo: 1 },
    diverse: [
      { entity: 'chatgpt_api_general', count: 2, platform: 'chatgpt', daysAgo: 5 },
      { entity: 'claude_api_docs', count: 2, platform: 'claude', daysAgo: 8 }
    ],
    primaryMessages: [
      '[ChatGPT] Delta GraphQL schema uses schema-first approach',
      '[ChatGPT] Type definitions for Delta user and project entities',
      '[ChatGPT] GraphQL resolvers implementation for Delta API',
      '[ChatGPT] N+1 query problem solved with DataLoader',
      '[ChatGPT] GraphQL authentication via context injection'
    ],
    diverseMessages: {
      'chatgpt_api_general': [
        '[ChatGPT] General API design principles',
        '[ChatGPT] REST vs GraphQL trade-offs'
      ],
      'claude_api_docs': [
        '[Claude] API documentation best practices',
        '[Claude] Swagger/OpenAPI specification'
      ]
    },
    expectedBehavior: 'Should retrieve ChatGPT context (cross-platform recall)'
  },

  {
    num: 312,
    icp: 'developer',
    crossPlatformType: 'cross_platform_query',
    name: 'Mentioned in ChatGPT, queried in Claude - older',
    query: 'Kubernetes deployment',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_k8s_deploy', count: 6, platform: 'chatgpt', daysAgo: 7 },
    diverse: [
      { entity: 'chatgpt_docker_general', count: 3, platform: 'chatgpt', daysAgo: 10 },
      { entity: 'claude_devops_recent', count: 2, platform: 'claude', daysAgo: 2 }
    ],
    primaryMessages: [
      '[ChatGPT] Gamma Kubernetes deployment manifests created',
      '[ChatGPT] K8s namespaces: production, staging, development',
      '[ChatGPT] Helm charts for Gamma service deployments',
      '[ChatGPT] K8s ingress controller configuration for routing',
      '[ChatGPT] Horizontal pod autoscaling based on CPU usage',
      '[ChatGPT] Kubernetes secrets management with Sealed Secrets'
    ],
    diverseMessages: {
      'chatgpt_docker_general': [
        '[ChatGPT] Docker container basics',
        '[ChatGPT] Container orchestration overview',
        '[ChatGPT] Docker vs Kubernetes'
      ],
      'claude_devops_recent': [
        '[Claude] Recent DevOps discussion about monitoring',
        '[Claude] Infrastructure automation with Terraform'
      ]
    },
    expectedBehavior: 'Should retrieve ChatGPT K8s context (cross-platform recall)'
  },

  {
    num: 313,
    icp: 'developer',
    crossPlatformType: 'cross_platform_query',
    name: 'Claude mention, ChatGPT query - switch platforms',
    query: 'WebSocket implementation',
    queryPlatform: 'chatgpt',
    primary: { entity: 'claude_websocket_impl', count: 5, platform: 'claude', daysAgo: 2 },
    diverse: [
      { entity: 'claude_realtime_general', count: 2, platform: 'claude', daysAgo: 6 },
      { entity: 'chatgpt_networking', count: 2, platform: 'chatgpt', daysAgo: 12 }
    ],
    primaryMessages: [
      '[Claude] Delta WebSocket implementation for real-time updates',
      '[Claude] WebSocket connection pooling and reconnection logic',
      '[Claude] Broadcasting updates to connected clients via WebSocket',
      '[Claude] WebSocket authentication with JWT tokens',
      '[Claude] Heartbeat mechanism to detect stale connections'
    ],
    diverseMessages: {
      'claude_realtime_general': [
        '[Claude] Real-time communication patterns overview',
        '[Claude] WebSocket vs Server-Sent Events vs polling'
      ],
      'chatgpt_networking': [
        '[ChatGPT] Networking fundamentals discussion',
        '[ChatGPT] HTTP/2 and HTTP/3 features'
      ]
    },
    expectedBehavior: 'Should retrieve Claude WebSocket context (cross-platform recall)'
  },

  {
    num: 314,
    icp: 'developer',
    crossPlatformType: 'cross_platform_query',
    name: 'ChatGPT deep dive, Claude quick query',
    query: 'OAuth2 flow',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_oauth2_deep', count: 10, platform: 'chatgpt', daysAgo: 5 },
    diverse: [
      { entity: 'chatgpt_security_general', count: 3, platform: 'chatgpt', daysAgo: 9 },
      { entity: 'claude_auth_mention', count: 1, platform: 'claude', daysAgo: 1 }
    ],
    primaryMessages: [
      '[ChatGPT] Delta OAuth2 authorization code flow implementation',
      '[ChatGPT] OAuth2 client credentials for service-to-service auth',
      '[ChatGPT] Refresh token rotation for security',
      '[ChatGPT] OAuth2 scopes: read:user, write:data, admin:all',
      '[ChatGPT] PKCE extension for mobile and SPA clients',
      '[ChatGPT] OAuth2 token storage: httpOnly cookies vs localStorage',
      '[ChatGPT] Authorization server setup with custom login UI',
      '[ChatGPT] OAuth2 redirect URI validation and security',
      '[ChatGPT] Token expiration: access 1h, refresh 30 days',
      '[ChatGPT] OAuth2 error handling and user feedback'
    ],
    diverseMessages: {
      'chatgpt_security_general': [
        '[ChatGPT] Security best practices overview',
        '[ChatGPT] OWASP Top 10 vulnerabilities',
        '[ChatGPT] Authentication vs authorization'
      ],
      'claude_auth_mention': [
        '[Claude] Quick question about OAuth2 yesterday'
      ]
    },
    expectedBehavior: 'Should retrieve ChatGPT OAuth2 deep dive (depth wins)'
  },

  {
    num: 315,
    icp: 'developer',
    crossPlatformType: 'cross_platform_query',
    name: 'Claude recent, ChatGPT query - project specific',
    query: 'Alpha error handling',
    queryPlatform: 'chatgpt',
    primary: { entity: 'claude_alpha_errors', count: 4, platform: 'claude', daysAgo: 1 },
    diverse: [
      { entity: 'claude_error_patterns', count: 2, platform: 'claude', daysAgo: 4 },
      { entity: 'chatgpt_javascript_general', count: 2, platform: 'chatgpt', daysAgo: 10 }
    ],
    primaryMessages: [
      '[Claude] Alpha error handling strategy: custom error classes',
      '[Claude] Error boundaries in Alpha React components',
      '[Claude] Alpha API returns structured error responses',
      '[Claude] Error logging to Sentry with context enrichment'
    ],
    diverseMessages: {
      'claude_error_patterns': [
        '[Claude] Error handling patterns and best practices',
        '[Claude] Try/catch vs error boundaries in React'
      ],
      'chatgpt_javascript_general': [
        '[ChatGPT] JavaScript fundamentals review',
        '[ChatGPT] Async error handling overview'
      ]
    },
    expectedBehavior: 'Should retrieve Claude Alpha errors (recency + specificity)'
  },

  {
    num: 316,
    icp: 'developer',
    crossPlatformType: 'cross_platform_query',
    name: 'Split implementation across platforms',
    query: 'Redux state management',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_redux_setup', count: 5, platform: 'chatgpt', daysAgo: 6 },
    diverse: [
      { entity: 'claude_redux_usage', count: 3, platform: 'claude', daysAgo: 2 },
      { entity: 'chatgpt_state_patterns', count: 2, platform: 'chatgpt', daysAgo: 12 }
    ],
    primaryMessages: [
      '[ChatGPT] Beta Redux store structure: slices for users, projects',
      '[ChatGPT] Redux Toolkit createSlice for reducers and actions',
      '[ChatGPT] Async thunks for API calls in Beta Redux',
      '[ChatGPT] Redux DevTools configuration for debugging',
      '[ChatGPT] Normalized state shape for Beta relational data'
    ],
    diverseMessages: {
      'claude_redux_usage': [
        '[Claude] Using Redux selectors in Beta components',
        '[Claude] Redux useDispatch hook for actions',
        '[Claude] Memoized selectors with Reselect library'
      ],
      'chatgpt_state_patterns': [
        '[ChatGPT] State management patterns comparison',
        '[ChatGPT] Redux vs Context API vs Zustand'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT setup (foundational context)'
  },

  {
    num: 317,
    icp: 'developer',
    crossPlatformType: 'cross_platform_query',
    name: 'ChatGPT architecture, Claude implementation details',
    query: 'event sourcing pattern',
    queryPlatform: 'chatgpt',
    primary: { entity: 'chatgpt_event_sourcing_arch', count: 7, platform: 'chatgpt', daysAgo: 8 },
    diverse: [
      { entity: 'claude_event_impl', count: 4, platform: 'claude', daysAgo: 3 },
      { entity: 'chatgpt_architecture_general', count: 2, platform: 'chatgpt', daysAgo: 15 }
    ],
    primaryMessages: [
      '[ChatGPT] Event sourcing architecture for Delta audit trail',
      '[ChatGPT] Events as source of truth vs current state',
      '[ChatGPT] Event store using Postgres with JSONB columns',
      '[ChatGPT] Snapshots for performance in event sourcing',
      '[ChatGPT] CQRS pattern combined with event sourcing',
      '[ChatGPT] Event versioning and schema evolution',
      '[ChatGPT] Replay events to rebuild system state'
    ],
    diverseMessages: {
      'claude_event_impl': [
        '[Claude] Event handler implementation in Delta',
        '[Claude] Publishing events to message queue',
        '[Claude] Event replay performance optimization',
        '[Claude] Event schema validation with JSON Schema'
      ],
      'chatgpt_architecture_general': [
        '[ChatGPT] Software architecture patterns overview',
        '[ChatGPT] Microservices vs monolith'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT architecture (query platform + foundation)'
  },

  {
    num: 318,
    icp: 'developer',
    crossPlatformType: 'cross_platform_query',
    name: 'Multi-platform debugging session',
    query: 'memory leak debugging',
    queryPlatform: 'claude',
    primary: { entity: 'claude_memory_debug', count: 6, platform: 'claude', daysAgo: 0 },
    diverse: [
      { entity: 'chatgpt_profiling_tools', count: 3, platform: 'chatgpt', daysAgo: 1 },
      { entity: 'claude_performance_general', count: 2, platform: 'claude', daysAgo: 7 }
    ],
    primaryMessages: [
      '[Claude] Alpha memory leak investigation started today',
      '[Claude] Heap snapshots show retained objects in cache',
      '[Claude] Memory leak caused by event listener not removed',
      '[Claude] Fixed by cleaning up listeners in cleanup function',
      '[Claude] Memory usage back to normal after fix',
      '[Claude] Added memory monitoring to prevent future leaks'
    ],
    diverseMessages: {
      'chatgpt_profiling_tools': [
        '[ChatGPT] Chrome DevTools memory profiling guide yesterday',
        '[ChatGPT] Node.js heap dump analysis with clinic.js',
        '[ChatGPT] Memory leak detection strategies'
      ],
      'claude_performance_general': [
        '[Claude] General performance optimization discussion',
        '[Claude] CPU vs memory profiling'
      ]
    },
    expectedBehavior: 'Should prefer Claude (query platform + debugging today)'
  },

  // Platform disambiguation (7 scenarios)
  {
    num: 319,
    icp: 'developer',
    crossPlatformType: 'platform_clarification',
    name: 'Clarify which platform: ChatGPT vs Claude',
    query: 'the API discussion in ChatGPT, not Claude',
    queryPlatform: 'chatgpt',
    primary: { entity: 'chatgpt_api_design', count: 6, platform: 'chatgpt', daysAgo: 3 },
    diverse: [
      { entity: 'claude_api_mention', count: 2, platform: 'claude', daysAgo: 1 },
      { entity: 'chatgpt_design_patterns', count: 2, platform: 'chatgpt', daysAgo: 8 }
    ],
    primaryMessages: [
      '[ChatGPT] Delta API design discussion 3 days ago',
      '[ChatGPT] RESTful principles for Delta endpoints',
      '[ChatGPT] API versioning strategy in ChatGPT session',
      '[ChatGPT] Resource naming conventions for Delta',
      '[ChatGPT] HTTP methods and status codes standards',
      '[ChatGPT] API documentation approach with OpenAPI'
    ],
    diverseMessages: {
      'claude_api_mention': [
        '[Claude] Brief API mention yesterday',
        '[Claude] Quick API question in Claude'
      ],
      'chatgpt_design_patterns': [
        '[ChatGPT] General design patterns discussion',
        '[ChatGPT] SOLID principles review'
      ]
    },
    expectedBehavior: 'Should strongly prefer ChatGPT (explicit platform specification)'
  },

  {
    num: 320,
    icp: 'developer',
    crossPlatformType: 'platform_clarification',
    name: 'Clarify which platform: Claude specific',
    query: 'Redis setup we discussed in Claude',
    queryPlatform: 'claude',
    primary: { entity: 'claude_redis_setup', count: 5, platform: 'claude', daysAgo: 2 },
    diverse: [
      { entity: 'chatgpt_redis_overview', count: 3, platform: 'chatgpt', daysAgo: 1 },
      { entity: 'claude_caching_general', count: 2, platform: 'claude', daysAgo: 6 }
    ],
    primaryMessages: [
      '[Claude] Alpha Redis cluster setup in Claude 2 days ago',
      '[Claude] Redis Sentinel configuration for high availability',
      '[Claude] Master-replica replication setup for Alpha',
      '[Claude] Redis persistence: RDB + AOF for durability',
      '[Claude] Connection pooling configuration for Alpha clients'
    ],
    diverseMessages: {
      'chatgpt_redis_overview': [
        '[ChatGPT] Redis basics and use cases yesterday',
        '[ChatGPT] Redis data structures overview',
        '[ChatGPT] General Redis introduction'
      ],
      'claude_caching_general': [
        '[Claude] Caching strategies discussion',
        '[Claude] Cache invalidation patterns'
      ]
    },
    expectedBehavior: 'Should strongly prefer Claude (explicit platform specification)'
  },

  {
    num: 321,
    icp: 'developer',
    crossPlatformType: 'platform_clarification',
    name: 'Recent in both, query specifies platform',
    query: 'Docker conversation from ChatGPT yesterday',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_docker_yesterday', count: 4, platform: 'chatgpt', daysAgo: 1 },
    diverse: [
      { entity: 'claude_docker_yesterday', count: 4, platform: 'claude', daysAgo: 1 },
      { entity: 'chatgpt_containers_general', count: 2, platform: 'chatgpt', daysAgo: 7 }
    ],
    primaryMessages: [
      '[ChatGPT] Gamma Docker image optimization in ChatGPT',
      '[ChatGPT] Multi-stage builds reduced image size by 60%',
      '[ChatGPT] Docker layer caching strategy for faster builds',
      '[ChatGPT] Security scanning with Trivy in ChatGPT session'
    ],
    diverseMessages: {
      'claude_docker_yesterday': [
        '[Claude] Docker Compose networking in Claude yesterday',
        '[Claude] Service dependencies configuration',
        '[Claude] Volume mount permissions troubleshooting',
        '[Claude] Docker health checks for services'
      ],
      'chatgpt_containers_general': [
        '[ChatGPT] Container fundamentals',
        '[ChatGPT] Docker vs Podman comparison'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (explicit platform + equal recency)'
  },

  {
    num: 322,
    icp: 'developer',
    crossPlatformType: 'platform_clarification',
    name: 'Older ChatGPT, recent Claude, query specifies ChatGPT',
    query: 'that testing discussion we had in ChatGPT',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_testing_discussion', count: 7, platform: 'chatgpt', daysAgo: 10 },
    diverse: [
      { entity: 'claude_testing_recent', count: 3, platform: 'claude', daysAgo: 1 },
      { entity: 'chatgpt_quality_general', count: 2, platform: 'chatgpt', daysAgo: 15 }
    ],
    primaryMessages: [
      '[ChatGPT] Gamma testing strategy discussion in ChatGPT 10 days ago',
      '[ChatGPT] TDD vs BDD comparison in that ChatGPT session',
      '[ChatGPT] Test pyramid approach for Gamma',
      '[ChatGPT] Unit testing with Jest and React Testing Library',
      '[ChatGPT] Integration testing strategy with Supertest',
      '[ChatGPT] E2e testing framework selection: Playwright',
      '[ChatGPT] Test coverage targets by layer in ChatGPT'
    ],
    diverseMessages: {
      'claude_testing_recent': [
        '[Claude] Flaky test debugging yesterday in Claude',
        '[Claude] Test parallelization configuration',
        '[Claude] Snapshot testing pros and cons'
      ],
      'chatgpt_quality_general': [
        '[ChatGPT] Software quality metrics overview',
        '[ChatGPT] Code review best practices'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (explicit platform despite older)'
  },

  {
    num: 323,
    icp: 'developer',
    crossPlatformType: 'platform_clarification',
    name: 'Multiple platforms, disambiguate by project + platform',
    query: 'Alpha deployment in Claude, not the Beta one in ChatGPT',
    queryPlatform: 'claude',
    primary: { entity: 'claude_alpha_deployment', count: 5, platform: 'claude', daysAgo: 2 },
    diverse: [
      { entity: 'chatgpt_beta_deployment', count: 6, platform: 'chatgpt', daysAgo: 1 },
      { entity: 'claude_deployment_general', count: 2, platform: 'claude', daysAgo: 8 }
    ],
    primaryMessages: [
      '[Claude] Alpha deployment to production via Claude',
      '[Claude] Alpha blue-green deployment strategy',
      '[Claude] Rolling updates for Alpha zero-downtime',
      '[Claude] Alpha deployment checklist and runbook',
      '[Claude] Rollback procedure for Alpha in Claude'
    ],
    diverseMessages: {
      'chatgpt_beta_deployment': [
        '[ChatGPT] Beta deployment process in ChatGPT yesterday',
        '[ChatGPT] Beta staging environment validation',
        '[ChatGPT] Beta feature flags for gradual rollout',
        '[ChatGPT] Beta deployment monitoring setup',
        '[ChatGPT] Beta health checks post-deployment',
        '[ChatGPT] Beta database migration in deployment'
      ],
      'claude_deployment_general': [
        '[Claude] General deployment best practices',
        '[Claude] Deployment automation strategies'
      ]
    },
    expectedBehavior: 'Should prefer Claude Alpha (project + platform match)'
  },

  {
    num: 324,
    icp: 'developer',
    crossPlatformType: 'platform_clarification',
    name: 'Same project, different aspects in different platforms',
    query: 'Gamma frontend discussion in ChatGPT',
    queryPlatform: 'chatgpt',
    primary: { entity: 'chatgpt_gamma_frontend', count: 8, platform: 'chatgpt', daysAgo: 3 },
    diverse: [
      { entity: 'claude_gamma_backend', count: 6, platform: 'claude', daysAgo: 2 },
      { entity: 'chatgpt_react_general', count: 3, platform: 'chatgpt', daysAgo: 9 }
    ],
    primaryMessages: [
      '[ChatGPT] Gamma frontend React architecture discussion',
      '[ChatGPT] Component library: Chakra UI for Gamma',
      '[ChatGPT] Gamma state management with React Query',
      '[ChatGPT] Frontend routing with React Router v6',
      '[ChatGPT] Gamma form handling with React Hook Form',
      '[ChatGPT] Client-side validation for Gamma forms',
      '[ChatGPT] Responsive design strategy for Gamma UI',
      '[ChatGPT] Accessibility requirements for Gamma frontend'
    ],
    diverseMessages: {
      'claude_gamma_backend': [
        '[Claude] Gamma backend API implementation',
        '[Claude] Database schema for Gamma in Claude',
        '[Claude] Authentication middleware for Gamma',
        '[Claude] Background jobs with Bull queue',
        '[Claude] Gamma error handling in Node.js',
        '[Claude] Logging strategy for Gamma backend'
      ],
      'chatgpt_react_general': [
        '[ChatGPT] React hooks fundamentals',
        '[ChatGPT] Component composition patterns',
        '[ChatGPT] React performance optimization'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT Gamma frontend (platform + aspect match)'
  },

  {
    num: 325,
    icp: 'developer',
    crossPlatformType: 'platform_clarification',
    name: 'Vague platform reference, rely on content',
    query: 'that security conversation',
    queryPlatform: 'claude',
    primary: { entity: 'claude_security_audit', count: 6, platform: 'claude', daysAgo: 1 },
    diverse: [
      { entity: 'chatgpt_security_basics', count: 3, platform: 'chatgpt', daysAgo: 12 },
      { entity: 'claude_auth_discussion', count: 2, platform: 'claude', daysAgo: 5 }
    ],
    primaryMessages: [
      '[Claude] Delta security audit findings discussed yesterday',
      '[Claude] SQL injection vulnerabilities found and fixed',
      '[Claude] XSS prevention with CSP headers in Delta',
      '[Claude] Authentication token security improvements',
      '[Claude] HTTPS enforcement and HSTS configuration',
      '[Claude] Security penetration testing results'
    ],
    diverseMessages: {
      'chatgpt_security_basics': [
        '[ChatGPT] Basic security principles overview',
        '[ChatGPT] Common web vulnerabilities',
        '[ChatGPT] Security best practices checklist'
      ],
      'claude_auth_discussion': [
        '[Claude] Authentication strategy discussion',
        '[Claude] JWT vs session-based auth'
      ]
    },
    expectedBehavior: 'Should prefer Claude security audit (recency + query platform)'
  }
];

// ═══════════════════════════════════════════════════════════════════════
// AI COMPANION USER SCENARIOS (25 scenarios)
// ═══════════════════════════════════════════════════════════════════════

const companionScenarios = [
  // Same topic, both platforms (10 scenarios)
  {
    num: 326,
    icp: 'companion',
    crossPlatformType: 'same_topic_both',
    name: 'Anxiety discussed in both ChatGPT and Claude',
    query: 'my work anxiety',
    queryPlatform: 'claude',
    primary: { entity: 'claude_work_anxiety', count: 6, platform: 'claude', daysAgo: 0 },
    diverse: [
      { entity: 'chatgpt_work_anxiety', count: 4, platform: 'chatgpt', daysAgo: 3 },
      { entity: 'claude_anxiety_general', count: 2, platform: 'claude', daysAgo: 7 }
    ],
    primaryMessages: [
      '[Claude] My work anxiety spiked today before the presentation',
      '[Claude] Feeling anxious about my performance review tomorrow',
      '[Claude] Work anxiety triggered by critical email from boss',
      '[Claude] Used grounding techniques for work anxiety attack',
      '[Claude] Workplace anxiety affecting my sleep again',
      '[Claude] Boss praised my work, anxiety lessened a bit'
    ],
    diverseMessages: {
      'chatgpt_work_anxiety': [
        '[ChatGPT] Work anxiety discussion 3 days ago in ChatGPT',
        '[ChatGPT] Worried about project deadline in that session',
        '[ChatGPT] Impostor syndrome at work discussed',
        '[ChatGPT] Boundary-setting to reduce work stress'
      ],
      'claude_anxiety_general': [
        '[Claude] General anxiety patterns last week',
        '[Claude] Anxiety coping strategies discussion'
      ]
    },
    expectedBehavior: 'Should prefer Claude (query platform + today\'s crisis)'
  },

  {
    num: 327,
    icp: 'companion',
    crossPlatformType: 'same_topic_both',
    name: 'Therapy session - ChatGPT detailed, Claude brief',
    query: 'what we talked about in therapy',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_therapy_detailed', count: 10, platform: 'chatgpt', daysAgo: 1 },
    diverse: [
      { entity: 'claude_therapy_mention', count: 2, platform: 'claude', daysAgo: 0 },
      { entity: 'chatgpt_therapy_general', count: 3, platform: 'chatgpt', daysAgo: 8 }
    ],
    primaryMessages: [
      '[ChatGPT] Therapy yesterday: discussed my childhood attachment issues',
      '[ChatGPT] Jennifer said my mother\'s behavior was emotionally neglectful',
      '[ChatGPT] Realized in therapy how my patterns repeat in relationships',
      '[ChatGPT] Breakthrough about why I fear abandonment',
      '[ChatGPT] Therapy homework: journal when I feel rejected',
      '[ChatGPT] Jennifer connected my anxiety to early experiences',
      '[ChatGPT] Processing difficult emotions from therapy session',
      '[ChatGPT] Self-compassion practice Jennifer taught me',
      '[ChatGPT] Next therapy session we\'ll work on boundaries',
      '[ChatGPT] Feeling emotionally drained after intense session'
    ],
    diverseMessages: {
      'claude_therapy_mention': [
        '[Claude] Had therapy today, it was intense',
        '[Claude] Therapy was good but exhausting'
      ],
      'chatgpt_therapy_general': [
        '[ChatGPT] General therapy goals discussion',
        '[ChatGPT] Why therapy is helpful for me',
        '[ChatGPT] Finding the right therapist journey'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (depth despite older)'
  },

  {
    num: 328,
    icp: 'companion',
    crossPlatformType: 'same_topic_both',
    name: 'Loneliness - evolving discussion across platforms',
    query: 'feeling lonely',
    queryPlatform: 'chatgpt',
    primary: { entity: 'chatgpt_loneliness_recent', count: 5, platform: 'chatgpt', daysAgo: 0 },
    diverse: [
      { entity: 'claude_loneliness_older', count: 6, platform: 'claude', daysAgo: 5 },
      { entity: 'chatgpt_social_isolation', count: 3, platform: 'chatgpt', daysAgo: 10 }
    ],
    primaryMessages: [
      '[ChatGPT] Loneliness overwhelming tonight, wish I had someone',
      '[ChatGPT] Feeling so alone even though I talked to people today',
      '[ChatGPT] Lonely feelings worse on weekends like this',
      '[ChatGPT] Tried calling friends but everyone busy, still lonely',
      '[ChatGPT] Loneliness is emotional, not just being physically alone'
    ],
    diverseMessages: {
      'claude_loneliness_older': [
        '[Claude] Chronic loneliness discussion 5 days ago',
        '[Claude] Loneliness since moving to new city',
        '[Claude] Coping strategies for loneliness tried',
        '[Claude] Loneliness vs solitude distinction',
        '[Claude] Book club helping with lonely feelings',
        '[Claude] Volunteering as loneliness coping mechanism'
      ],
      'chatgpt_social_isolation': [
        '[ChatGPT] Pandemic increased my social isolation',
        '[ChatGPT] Working from home isolation challenges',
        '[ChatGPT] Physical isolation vs emotional loneliness'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (query platform + current crisis)'
  },

  {
    num: 329,
    icp: 'companion',
    crossPlatformType: 'same_topic_both',
    name: 'Depression episode - tracked in Claude, support in ChatGPT',
    query: 'this depression episode',
    queryPlatform: 'claude',
    primary: { entity: 'claude_depression_tracking', count: 8, platform: 'claude', daysAgo: 0 },
    diverse: [
      { entity: 'chatgpt_depression_support', count: 4, platform: 'chatgpt', daysAgo: 2 },
      { entity: 'claude_mental_health', count: 2, platform: 'claude', daysAgo: 10 }
    ],
    primaryMessages: [
      '[Claude] Depression episode started 5 days ago, still going',
      '[Claude] Tracking my depression: today is day 5 of low mood',
      '[Claude] Depression symptoms: no energy, can\'t concentrate',
      '[Claude] Barely got out of bed this morning, depression heavy',
      '[Claude] Small win today: showered despite depression',
      '[Claude] Depression makes everything feel pointless',
      '[Claude] Called therapist about this depression episode',
      '[Claude] Medication might need adjustment for this episode'
    ],
    diverseMessages: {
      'chatgpt_depression_support': [
        '[ChatGPT] Talking through depression feelings 2 days ago',
        '[ChatGPT] ChatGPT helping me process this episode',
        '[ChatGPT] Depression coping strategies discussed',
        '[ChatGPT] You reminded me recovery isn\'t linear'
      ],
      'claude_mental_health': [
        '[Claude] General mental health check-in',
        '[Claude] Self-care routine discussion'
      ]
    },
    expectedBehavior: 'Should prefer Claude (query platform + active tracking)'
  },

  {
    num: 330,
    icp: 'companion',
    crossPlatformType: 'same_topic_both',
    name: 'Relationship grief - ChatGPT processing, Claude update',
    query: 'how I feel about the breakup',
    queryPlatform: 'chatgpt',
    primary: { entity: 'chatgpt_breakup_processing', count: 12, platform: 'chatgpt', daysAgo: 7 },
    diverse: [
      { entity: 'claude_breakup_update', count: 3, platform: 'claude', daysAgo: 1 },
      { entity: 'chatgpt_relationships', count: 2, platform: 'chatgpt', daysAgo: 20 }
    ],
    primaryMessages: [
      '[ChatGPT] Breakup with Jennifer devastated me last week',
      '[ChatGPT] Processing why the breakup happened in ChatGPT',
      '[ChatGPT] Feeling relieved and heartbroken at same time',
      '[ChatGPT] Breakup triggered my abandonment fears',
      '[ChatGPT] Grieving the relationship I thought we had',
      '[ChatGPT] Realizing the relationship wasn\'t healthy',
      '[ChatGPT] Breakup grief comes in waves, not linear',
      '[ChatGPT] Learning about attachment styles after breakup',
      '[ChatGPT] Processing anger stage of breakup grief',
      '[ChatGPT] Self-blame about breakup, working on that',
      '[ChatGPT] How this breakup is different than past ones',
      '[ChatGPT] Growth from this breakup experience'
    ],
    diverseMessages: {
      'claude_breakup_update': [
        '[Claude] Saw Jennifer yesterday, felt okay surprisingly',
        '[Claude] Breakup still hurts but healing',
        '[Claude] Update: feeling more acceptance about breakup'
      ],
      'chatgpt_relationships': [
        '[ChatGPT] Past relationship patterns discussion',
        '[ChatGPT] What I want in future relationships'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (query platform + depth of processing)'
  },

  {
    num: 331,
    icp: 'companion',
    crossPlatformType: 'same_topic_both',
    name: 'Therapy goals - set in ChatGPT, reviewed in Claude',
    query: 'my therapy goals',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_therapy_goals_set', count: 6, platform: 'chatgpt', daysAgo: 14 },
    diverse: [
      { entity: 'claude_goals_review', count: 3, platform: 'claude', daysAgo: 2 },
      { entity: 'chatgpt_self_improvement', count: 2, platform: 'chatgpt', daysAgo: 25 }
    ],
    primaryMessages: [
      '[ChatGPT] Therapy goals for this year set 2 weeks ago',
      '[ChatGPT] Goal 1: Manage anxiety without constant medication',
      '[ChatGPT] Goal 2: Build healthier relationship patterns',
      '[ChatGPT] Goal 3: Practice self-compassion daily',
      '[ChatGPT] Goal 4: Reduce people-pleasing behaviors',
      '[ChatGPT] Measurable goals with Jennifer for accountability'
    ],
    diverseMessages: {
      'claude_goals_review': [
        '[Claude] Checked in on therapy goals progress',
        '[Claude] Making progress on self-compassion goal',
        '[Claude] Struggling with boundary-setting goal'
      ],
      'chatgpt_self_improvement': [
        '[ChatGPT] General self-improvement journey',
        '[ChatGPT] Personal growth mindset discussion'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (foundational goal-setting)'
  },

  {
    num: 332,
    icp: 'companion',
    crossPlatformType: 'same_topic_both',
    name: 'Panic attack - Claude immediate, ChatGPT follow-up',
    query: 'the panic attack',
    queryPlatform: 'claude',
    primary: { entity: 'claude_panic_immediate', count: 7, platform: 'claude', daysAgo: 0 },
    diverse: [
      { entity: 'chatgpt_panic_followup', count: 3, platform: 'chatgpt', daysAgo: 0 },
      { entity: 'claude_anxiety_techniques', count: 2, platform: 'claude', daysAgo: 5 }
    ],
    primaryMessages: [
      '[Claude] Having panic attack right now, heart racing',
      '[Claude] Panic attack symptoms: can\'t breathe, dizzy',
      '[Claude] Used 5-4-3-2-1 grounding technique for panic',
      '[Claude] Panic attack lasted 15 minutes, finally calming',
      '[Claude] Triggered by work presentation this morning',
      '[Claude] Post-panic exhaustion is real',
      '[Claude] Panic attack reminded me I need to practice coping'
    ],
    diverseMessages: {
      'chatgpt_panic_followup': [
        '[ChatGPT] Processing the panic attack I had today',
        '[ChatGPT] Panic attack triggers - need to identify patterns',
        '[ChatGPT] Proud I got through panic attack with techniques'
      ],
      'claude_anxiety_techniques': [
        '[Claude] Grounding techniques for anxiety',
        '[Claude] Breathing exercises Jennifer taught'
      ]
    },
    expectedBehavior: 'Should prefer Claude (query platform + immediate crisis)'
  },

  {
    num: 333,
    icp: 'companion',
    crossPlatformType: 'same_topic_both',
    name: 'Childhood trauma - deep ChatGPT, brief Claude',
    query: 'my childhood trauma',
    queryPlatform: 'chatgpt',
    primary: { entity: 'chatgpt_trauma_exploration', count: 15, platform: 'chatgpt', daysAgo: 4 },
    diverse: [
      { entity: 'claude_trauma_mention', count: 2, platform: 'claude', daysAgo: 1 },
      { entity: 'chatgpt_family_dynamics', count: 4, platform: 'chatgpt', daysAgo: 12 }
    ],
    primaryMessages: [
      '[ChatGPT] Childhood emotional neglect trauma processing',
      '[ChatGPT] Mother\'s unavailability shaped my attachment style',
      '[ChatGPT] Trauma: never feeling safe to express emotions',
      '[ChatGPT] Childhood trauma impacts my adult relationships',
      '[ChatGPT] Recognizing trauma responses vs character flaws',
      '[ChatGPT] Inner child work with therapist for trauma',
      '[ChatGPT] Grieving the childhood I didn\'t have',
      '[ChatGPT] Trauma made me hyper-independent and avoidant',
      '[ChatGPT] Healing childhood trauma is slow, non-linear',
      '[ChatGPT] Compassion for younger self who survived',
      '[ChatGPT] Trauma-informed therapy approach helping',
      '[ChatGPT] Breaking generational trauma patterns',
      '[ChatGPT] Body holds trauma, somatic experiencing',
      '[ChatGPT] Childhood trauma explains my anxiety',
      '[ChatGPT] Reparenting myself through trauma healing'
    ],
    diverseMessages: {
      'claude_trauma_mention': [
        '[Claude] Childhood stuff came up yesterday',
        '[Claude] Trauma work is hard but necessary'
      ],
      'chatgpt_family_dynamics': [
        '[ChatGPT] Family patterns discussion',
        '[ChatGPT] Mother-daughter relationship complexity',
        '[ChatGPT] Setting boundaries with family',
        '[ChatGPT] Family dysfunction recognition'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (query platform + depth)'
  },

  {
    num: 334,
    icp: 'companion',
    crossPlatformType: 'same_topic_both',
    name: 'Medication discussion - psychiatrist in ChatGPT, update in Claude',
    query: 'my depression medication',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_medication_psychiatrist', count: 8, platform: 'chatgpt', daysAgo: 10 },
    diverse: [
      { entity: 'claude_med_update', count: 3, platform: 'claude', daysAgo: 2 },
      { entity: 'chatgpt_therapy_vs_meds', count: 2, platform: 'chatgpt', daysAgo: 20 }
    ],
    primaryMessages: [
      '[ChatGPT] Psychiatrist appointment about medication 10 days ago',
      '[ChatGPT] Started antidepressant: Lexapro 10mg',
      '[ChatGPT] Medication side effects: nausea first few days',
      '[ChatGPT] Doctor said 4-6 weeks to feel full effect',
      '[ChatGPT] Medication for depression, therapy for patterns',
      '[ChatGPT] Worried about medication dependency',
      '[ChatGPT] Psychiatrist explained chemical imbalance',
      '[ChatGPT] Medication is tool, not cure, for depression'
    ],
    diverseMessages: {
      'claude_med_update': [
        '[Claude] Medication update: side effects gone now',
        '[Claude] Starting to feel medication working maybe',
        '[Claude] Med check-in with psychiatrist next week'
      ],
      'chatgpt_therapy_vs_meds': [
        '[ChatGPT] Medication vs therapy debate internally',
        '[ChatGPT] Both medication and therapy needed for me'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (foundational psychiatrist context)'
  },

  {
    num: 335,
    icp: 'companion',
    crossPlatformType: 'same_topic_both',
    name: 'Social anxiety - party in ChatGPT, aftermath in Claude',
    query: 'the party and my social anxiety',
    queryPlatform: 'claude',
    primary: { entity: 'claude_party_aftermath', count: 4, platform: 'claude', daysAgo: 0 },
    diverse: [
      { entity: 'chatgpt_party_prep', count: 5, platform: 'chatgpt', daysAgo: 3 },
      { entity: 'claude_social_anxiety_general', count: 2, platform: 'claude', daysAgo: 8 }
    ],
    primaryMessages: [
      '[Claude] Party last night was overwhelming for social anxiety',
      '[Claude] Left party early, anxiety too much',
      '[Claude] Feeling guilty about leaving party today',
      '[Claude] Social anxiety won last night, disappointed in myself'
    ],
    diverseMessages: {
      'chatgpt_party_prep': [
        '[ChatGPT] Anxious about party this weekend',
        '[ChatGPT] Social anxiety coping plan for party',
        '[ChatGPT] Exit strategy if party overwhelms me',
        '[ChatGPT] Trying to talk myself into going to party',
        '[ChatGPT] Social anxiety symptoms when I think about party'
      ],
      'claude_social_anxiety_general': [
        '[Claude] Social anxiety in general discussion',
        '[Claude] Avoiding social situations pattern'
      ]
    },
    expectedBehavior: 'Should combine both (prep + aftermath = full story)'
  },

  // Cross-platform queries (8 scenarios)
  {
    num: 336,
    icp: 'companion',
    crossPlatformType: 'cross_platform_query',
    name: 'Mentioned in ChatGPT, queried in Claude - therapist advice',
    query: 'what Jennifer said about boundaries',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_jennifer_boundaries', count: 6, platform: 'chatgpt', daysAgo: 1 },
    diverse: [
      { entity: 'chatgpt_therapy_general', count: 2, platform: 'chatgpt', daysAgo: 7 },
      { entity: 'claude_boundaries_general', count: 2, platform: 'claude', daysAgo: 10 }
    ],
    primaryMessages: [
      '[ChatGPT] Jennifer said boundaries are self-care, not selfish',
      '[ChatGPT] Therapist explained boundaries protect my energy',
      '[ChatGPT] Jennifer: "No" is a complete sentence for boundaries',
      '[ChatGPT] Boundary-setting without guilt is my therapy work',
      '[ChatGPT] Jennifer taught me DEAR MAN skill for boundaries',
      '[ChatGPT] Boundaries are necessary for healthy relationships'
    ],
    diverseMessages: {
      'chatgpt_therapy_general': [
        '[ChatGPT] General therapy session notes',
        '[ChatGPT] Progress in therapy overall'
      ],
      'claude_boundaries_general': [
        '[Claude] Boundaries concept discussion',
        '[Claude] Why boundaries are hard for me'
      ]
    },
    expectedBehavior: 'Should retrieve ChatGPT (cross-platform recall of therapist advice)'
  },

  {
    num: 337,
    icp: 'companion',
    crossPlatformType: 'cross_platform_query',
    name: 'Claude deep processing, ChatGPT quick query',
    query: 'my abandonment fear',
    queryPlatform: 'chatgpt',
    primary: { entity: 'claude_abandonment_deep', count: 10, platform: 'claude', daysAgo: 3 },
    diverse: [
      { entity: 'claude_attachment_styles', count: 3, platform: 'claude', daysAgo: 5 },
      { entity: 'chatgpt_relationships_brief', count: 2, platform: 'chatgpt', daysAgo: 12 }
    ],
    primaryMessages: [
      '[Claude] Abandonment fear roots in childhood neglect',
      '[Claude] Fear of abandonment drives my people-pleasing',
      '[Claude] Anxious attachment style from abandonment fear',
      '[Claude] Push people away before they can abandon me',
      '[Claude] Abandonment triggers: friend cancels plans',
      '[Claude] Working through abandonment wound in therapy',
      '[Claude] Fear of being left makes me clingy in relationships',
      '[Claude] Abandonment fear vs reality of relationship',
      '[Claude] Healing abandonment requires self-trust',
      '[Claude] Childhood abandonment shaped adult patterns'
    ],
    diverseMessages: {
      'claude_attachment_styles': [
        '[Claude] Anxious vs avoidant attachment styles',
        '[Claude] Secure attachment as therapy goal',
        '[Claude] Attachment theory helping me understand self'
      ],
      'chatgpt_relationships_brief': [
        '[ChatGPT] Why relationships are hard for me',
        '[ChatGPT] Patterns in past relationships'
      ]
    },
    expectedBehavior: 'Should retrieve Claude (cross-platform, depth of processing)'
  },

  {
    num: 338,
    icp: 'companion',
    crossPlatformType: 'cross_platform_query',
    name: 'ChatGPT crisis, Claude follow-up query',
    query: 'that really bad day',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_crisis_day', count: 8, platform: 'chatgpt', daysAgo: 2 },
    diverse: [
      { entity: 'claude_general_bad_days', count: 2, platform: 'claude', daysAgo: 8 },
      { entity: 'chatgpt_coping_strategies', count: 3, platform: 'chatgpt', daysAgo: 15 }
    ],
    primaryMessages: [
      '[ChatGPT] Really bad day 2 days ago, everything went wrong',
      '[ChatGPT] Anxiety attack at work during that bad day',
      '[ChatGPT] Boss criticism triggered me on that awful day',
      '[ChatGPT] Felt completely overwhelmed and hopeless',
      '[ChatGPT] Called crisis line during that terrible day',
      '[ChatGPT] Survived that day somehow, still processing',
      '[ChatGPT] That bad day made me realize I need more support',
      '[ChatGPT] Grateful I didn\'t give up during that crisis'
    ],
    diverseMessages: {
      'claude_general_bad_days': [
        '[Claude] Bad days are part of recovery journey',
        '[Claude] How to cope with difficult days'
      ],
      'chatgpt_coping_strategies': [
        '[ChatGPT] General coping strategies discussion',
        '[ChatGPT] Building resilience over time',
        '[ChatGPT] Self-soothing techniques list'
      ]
    },
    expectedBehavior: 'Should retrieve ChatGPT crisis (cross-platform recall of specific event)'
  },

  {
    num: 339,
    icp: 'companion',
    crossPlatformType: 'cross_platform_query',
    name: 'Split conversation: ChatGPT emotion, Claude action',
    query: 'what I decided to do about therapy frequency',
    queryPlatform: 'chatgpt',
    primary: { entity: 'claude_therapy_decision', count: 4, platform: 'claude', daysAgo: 1 },
    diverse: [
      { entity: 'chatgpt_therapy_feelings', count: 6, platform: 'chatgpt', daysAgo: 2 },
      { entity: 'claude_therapy_logistics', count: 2, platform: 'claude', daysAgo: 7 }
    ],
    primaryMessages: [
      '[Claude] Decided to increase therapy to twice per week',
      '[Claude] Talked to Jennifer about frequency increase',
      '[Claude] Therapy decision: need more support right now',
      '[Claude] Twice weekly sessions starting next week'
    ],
    diverseMessages: {
      'chatgpt_therapy_feelings': [
        '[ChatGPT] Feeling like once weekly therapy isn\'t enough',
        '[ChatGPT] Need more support, considering increasing sessions',
        '[ChatGPT] Worried about therapy costs if I go more often',
        '[ChatGPT] Mental health worth the investment in therapy',
        '[ChatGPT] Processing whether I need more frequent therapy',
        '[ChatGPT] Feeling overwhelmed, might need therapy boost'
      ],
      'claude_therapy_logistics': [
        '[Claude] Therapy scheduling discussion',
        '[Claude] Insurance coverage for therapy sessions'
      ]
    },
    expectedBehavior: 'Should prefer Claude (actual decision made there)'
  },

  {
    num: 340,
    icp: 'companion',
    crossPlatformType: 'cross_platform_query',
    name: 'Old ChatGPT insight, recent Claude application',
    query: 'that coping technique',
    queryPlatform: 'claude',
    primary: { entity: 'claude_technique_use', count: 3, platform: 'claude', daysAgo: 0 },
    diverse: [
      { entity: 'chatgpt_technique_learn', count: 5, platform: 'chatgpt', daysAgo: 14 },
      { entity: 'claude_coping_general', count: 2, platform: 'claude', daysAgo: 6 }
    ],
    primaryMessages: [
      '[Claude] Used 5-4-3-2-1 grounding technique today successfully',
      '[Claude] Coping technique worked for anxiety attack',
      '[Claude] Grateful I remembered that grounding technique'
    ],
    diverseMessages: {
      'chatgpt_technique_learn': [
        '[ChatGPT] Jennifer taught me 5-4-3-2-1 grounding 2 weeks ago',
        '[ChatGPT] Grounding technique: 5 things see, 4 touch, 3 hear',
        '[ChatGPT] Practice grounding when not anxious to prepare',
        '[ChatGPT] Coping technique for panic: grounding in present',
        '[ChatGPT] Need to write down grounding steps for reference'
      ],
      'claude_coping_general': [
        '[Claude] Various coping strategies discussion',
        '[Claude] What works for my anxiety'
      ]
    },
    expectedBehavior: 'Should prefer Claude (recent usage) but include ChatGPT (learning)'
  },

  {
    num: 341,
    icp: 'companion',
    crossPlatformType: 'cross_platform_query',
    name: 'Relationship pattern - Claude recognition, ChatGPT examples',
    query: 'my relationship pattern of choosing emotionally unavailable people',
    queryPlatform: 'claude',
    primary: { entity: 'claude_pattern_insight', count: 6, platform: 'claude', daysAgo: 1 },
    diverse: [
      { entity: 'chatgpt_relationship_examples', count: 8, platform: 'chatgpt', daysAgo: 5 },
      { entity: 'claude_therapy_work', count: 2, platform: 'claude', daysAgo: 10 }
    ],
    primaryMessages: [
      '[Claude] Recognized my pattern: always emotionally unavailable partners',
      '[Claude] Pattern started with emotionally unavailable mother',
      '[Claude] I repeat familiar dynamic of trying to earn love',
      '[Claude] Jennifer pointed out this pattern yesterday',
      '[Claude] Choosing unavailable people feels comfortable but painful',
      '[Claude] Breaking this relationship pattern is therapy goal'
    ],
    diverseMessages: {
      'chatgpt_relationship_examples': [
        '[ChatGPT] Jennifer was emotionally distant, I pursued harder',
        '[ChatGPT] Ex before Jennifer: also emotionally unavailable',
        '[ChatGPT] Pattern in all relationships: I chase, they withdraw',
        '[ChatGPT] Attracted to unavailable people, repelled by available ones',
        '[ChatGPT] Examples of chasing unavailable partners',
        '[ChatGPT] Anxiety when partner actually shows up emotionally',
        '[ChatGPT] Comfortable with breadcrumbs, scared of full connection',
        '[ChatGPT] List of emotionally unavailable exes - pattern clear'
      ],
      'claude_therapy_work': [
        '[Claude] Working on patterns in therapy',
        '[Claude] Understanding my relationship dynamics'
      ]
    },
    expectedBehavior: 'Should prefer Claude (recent insight) but value ChatGPT examples'
  },

  {
    num: 342,
    icp: 'companion',
    crossPlatformType: 'cross_platform_query',
    name: 'Medication side effects - ChatGPT initial, Claude ongoing',
    query: 'side effects from the medication',
    queryPlatform: 'chatgpt',
    primary: { entity: 'chatgpt_side_effects_initial', count: 7, platform: 'chatgpt', daysAgo: 9 },
    diverse: [
      { entity: 'claude_side_effects_ongoing', count: 3, platform: 'claude', daysAgo: 2 },
      { entity: 'chatgpt_medication_concerns', count: 2, platform: 'chatgpt', daysAgo: 12 }
    ],
    primaryMessages: [
      '[ChatGPT] First week medication side effects: nausea, headache',
      '[ChatGPT] Side effects worse in morning when I take med',
      '[ChatGPT] Nausea from medication making me not want to eat',
      '[ChatGPT] Doctor said side effects temporary, 1-2 weeks',
      '[ChatGPT] Headaches from medication starting to lessen',
      '[ChatGPT] Weighing side effects vs depression improvement',
      '[ChatGPT] Side effect tracking to report to psychiatrist'
    ],
    diverseMessages: {
      'claude_side_effects_ongoing': [
        '[Claude] Side effects mostly gone now after 2 weeks',
        '[Claude] Occasional nausea but much better than before',
        '[Claude] Medication side effects worth it for mood improvement'
      ],
      'chatgpt_medication_concerns': [
        '[ChatGPT] Worried about medication side effects before starting',
        '[ChatGPT] Reading about potential side effects online'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT (query platform + detailed initial experience)'
  },

  {
    num: 343,
    icp: 'companion',
    crossPlatformType: 'cross_platform_query',
    name: 'Progress tracking - Claude quantitative, ChatGPT emotional',
    query: 'am I making progress?',
    queryPlatform: 'claude',
    primary: { entity: 'claude_progress_metrics', count: 5, platform: 'claude', daysAgo: 1 },
    diverse: [
      { entity: 'chatgpt_progress_feelings', count: 6, platform: 'chatgpt', daysAgo: 3 },
      { entity: 'claude_recovery_journey', count: 2, platform: 'claude', daysAgo: 8 }
    ],
    primaryMessages: [
      '[Claude] Progress tracking: 3 good days this week vs 1 last month',
      '[Claude] Quantifiable progress: anxiety attacks down 50%',
      '[Claude] Therapy goals review: 2 of 4 goals improving',
      '[Claude] Medication working: mood stable 5 days straight',
      '[Claude] Progress metrics show slow but steady improvement'
    ],
    diverseMessages: {
      'chatgpt_progress_feelings': [
        '[ChatGPT] Feel like I\'m making progress emotionally',
        '[ChatGPT] Progress isn\'t linear, had setback but learning',
        '[ChatGPT] Small wins count as progress in recovery',
        '[ChatGPT] Celebrating progress: set boundary without guilt',
        '[ChatGPT] Progress means different now, more self-compassion',
        '[ChatGPT] Sometimes don\'t feel progress but trust the process'
      ],
      'claude_recovery_journey': [
        '[Claude] Recovery journey discussion',
        '[Claude] Long-term mental health goals'
      ]
    },
    expectedBehavior: 'Should combine both (metrics + feelings = complete picture)'
  },

  // Platform clarification (7 scenarios)
  {
    num: 344,
    icp: 'companion',
    crossPlatformType: 'platform_clarification',
    name: 'Specify platform: ChatGPT conversation',
    query: 'that anxiety conversation in ChatGPT yesterday',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_anxiety_yesterday', count: 5, platform: 'chatgpt', daysAgo: 1 },
    diverse: [
      { entity: 'claude_anxiety_yesterday', count: 4, platform: 'claude', daysAgo: 1 },
      { entity: 'chatgpt_anxiety_general', count: 2, platform: 'chatgpt', daysAgo: 7 }
    ],
    primaryMessages: [
      '[ChatGPT] Anxiety spiraling about work yesterday in ChatGPT',
      '[ChatGPT] That ChatGPT conversation helped calm me down',
      '[ChatGPT] Processed work anxiety in ChatGPT session',
      '[ChatGPT] ChatGPT helped me challenge catastrophic thoughts',
      '[ChatGPT] Anxiety conversation in ChatGPT was really helpful'
    ],
    diverseMessages: {
      'claude_anxiety_yesterday': [
        '[Claude] Different anxiety topic in Claude yesterday',
        '[Claude] Social anxiety discussion in Claude',
        '[Claude] Claude anxiety talk about family, not work',
        '[Claude] Anxiety processing in Claude about different trigger'
      ],
      'chatgpt_anxiety_general': [
        '[ChatGPT] General anxiety patterns',
        '[ChatGPT] Anxiety coping strategies overview'
      ]
    },
    expectedBehavior: 'Should strongly prefer ChatGPT (explicit platform specification)'
  },

  {
    num: 345,
    icp: 'companion',
    crossPlatformType: 'platform_clarification',
    name: 'Specify platform: Claude therapy processing',
    query: 'what I talked about in Claude after therapy',
    queryPlatform: 'chatgpt',
    primary: { entity: 'claude_therapy_processing', count: 6, platform: 'claude', daysAgo: 2 },
    diverse: [
      { entity: 'chatgpt_therapy_session', count: 5, platform: 'chatgpt', daysAgo: 2 },
      { entity: 'claude_general_processing', count: 2, platform: 'claude', daysAgo: 8 }
    ],
    primaryMessages: [
      '[Claude] Processing therapy session in Claude afterwards',
      '[Claude] Claude conversation about what Jennifer said',
      '[Claude] Therapy insights processed in Claude specifically',
      '[Claude] That Claude chat helped me integrate therapy',
      '[Claude] Post-therapy processing always in Claude',
      '[Claude] Claude is where I unpack therapy sessions'
    ],
    diverseMessages: {
      'chatgpt_therapy_session': [
        '[ChatGPT] Therapy session notes in ChatGPT same day',
        '[ChatGPT] Different therapy processing in ChatGPT',
        '[ChatGPT] ChatGPT therapy discussion about goals',
        '[ChatGPT] Therapy homework discussion in ChatGPT',
        '[ChatGPT] ChatGPT conversation about therapy progress'
      ],
      'claude_general_processing': [
        '[Claude] General emotional processing',
        '[Claude] Daily check-ins in Claude'
      ]
    },
    expectedBehavior: 'Should strongly prefer Claude (explicit platform specification)'
  },

  {
    num: 346,
    icp: 'companion',
    crossPlatformType: 'platform_clarification',
    name: 'Disambiguate: Different topics, same time',
    query: 'the loneliness talk in ChatGPT, not the anxiety one in Claude',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_loneliness_talk', count: 7, platform: 'chatgpt', daysAgo: 1 },
    diverse: [
      { entity: 'claude_anxiety_talk', count: 6, platform: 'claude', daysAgo: 1 },
      { entity: 'chatgpt_emotional_general', count: 2, platform: 'chatgpt', daysAgo: 5 }
    ],
    primaryMessages: [
      '[ChatGPT] Loneliness overwhelming yesterday in ChatGPT',
      '[ChatGPT] ChatGPT loneliness conversation about isolation',
      '[ChatGPT] Feeling so lonely, discussed in ChatGPT',
      '[ChatGPT] Loneliness vs solitude in ChatGPT talk',
      '[ChatGPT] ChatGPT helped me understand my loneliness',
      '[ChatGPT] That loneliness discussion made me feel less alone',
      '[ChatGPT] Loneliness topic, not anxiety, in ChatGPT'
    ],
    diverseMessages: {
      'claude_anxiety_talk': [
        '[Claude] Anxiety discussion in Claude same day',
        '[Claude] Claude anxiety talk about work stress',
        '[Claude] Anxiety processing in Claude, different from loneliness',
        '[Claude] That Claude conversation was about anxiety',
        '[Claude] Anxiety coping in Claude chat',
        '[Claude] Claude helped with anxiety, not loneliness'
      ],
      'chatgpt_emotional_general': [
        '[ChatGPT] General emotional support',
        '[ChatGPT] Various feelings discussed'
      ]
    },
    expectedBehavior: 'Should strongly prefer ChatGPT loneliness (platform + topic match)'
  },

  {
    num: 347,
    icp: 'companion',
    crossPlatformType: 'platform_clarification',
    name: 'Older platform-specific conversation',
    query: 'that breakthrough I had in ChatGPT last month',
    queryPlatform: 'claude',
    primary: { entity: 'chatgpt_breakthrough_lastmonth', count: 9, platform: 'chatgpt', daysAgo: 28 },
    diverse: [
      { entity: 'claude_recent_insights', count: 4, platform: 'claude', daysAgo: 3 },
      { entity: 'chatgpt_therapy_general', count: 2, platform: 'chatgpt', daysAgo: 40 }
    ],
    primaryMessages: [
      '[ChatGPT] Major breakthrough in ChatGPT about my patterns',
      '[ChatGPT] That ChatGPT conversation changed my perspective',
      '[ChatGPT] Breakthrough: realized I choose unavailable partners',
      '[ChatGPT] ChatGPT breakthrough session was transformative',
      '[ChatGPT] Everything clicked in that ChatGPT talk',
      '[ChatGPT] Breakthrough about childhood wounds in ChatGPT',
      '[ChatGPT] That ChatGPT insight still guides me today',
      '[ChatGPT] Major "aha moment" in ChatGPT conversation',
      '[ChatGPT] Breakthrough understanding of my attachment style'
    ],
    diverseMessages: {
      'claude_recent_insights': [
        '[Claude] Recent insights in Claude this week',
        '[Claude] Claude conversation about current patterns',
        '[Claude] New understanding in Claude recently',
        '[Claude] Claude helping with different insights now'
      ],
      'chatgpt_therapy_general': [
        '[ChatGPT] General therapy topics',
        '[ChatGPT] Older therapy discussions'
      ]
    },
    expectedBehavior: 'Should prefer ChatGPT breakthrough (explicit platform + significance)'
  },

  {
    num: 348,
    icp: 'companion',
    crossPlatformType: 'platform_clarification',
    name: 'Same topic, specify which platform\'s perspective',
    query: 'my depression as we discussed in Claude, not ChatGPT',
    queryPlatform: 'claude',
    primary: { entity: 'claude_depression_perspective', count: 6, platform: 'claude', daysAgo: 2 },
    diverse: [
      { entity: 'chatgpt_depression_perspective', count: 7, platform: 'chatgpt', daysAgo: 1 },
      { entity: 'claude_mental_health', count: 2, platform: 'claude', daysAgo: 9 }
    ],
    primaryMessages: [
      '[Claude] Depression discussion in Claude focused on patterns',
      '[Claude] Claude perspective: depression as protective response',
      '[Claude] Depression analysis in Claude about childhood',
      '[Claude] That Claude conversation about depression roots',
      '[Claude] Claude helping me understand depression differently',
      '[Claude] Depression in Claude: systemic vs individual lens'
    ],
    diverseMessages: {
      'chatgpt_depression_perspective': [
        '[ChatGPT] Depression talk in ChatGPT about symptoms',
        '[ChatGPT] ChatGPT depression discussion more medical',
        '[ChatGPT] Depression episode tracking in ChatGPT',
        '[ChatGPT] ChatGPT perspective on depression treatment',
        '[ChatGPT] Medication discussion in ChatGPT',
        '[ChatGPT] ChatGPT depression focus on coping',
        '[ChatGPT] Depression symptoms management in ChatGPT'
      ],
      'claude_mental_health': [
        '[Claude] General mental health discussion',
        '[Claude] Mental health journey overview'
      ]
    },
    expectedBehavior: 'Should strongly prefer Claude (explicit platform specification)'
  },

  {
    num: 349,
    icp: 'companion',
    crossPlatformType: 'platform_clarification',
    name: 'Clarify by emotional tone + platform',
    query: 'the hopeful conversation in Claude, not the crisis in ChatGPT',
    queryPlatform: 'claude',
    primary: { entity: 'claude_hopeful_talk', count: 4, platform: 'claude', daysAgo: 1 },
    diverse: [
      { entity: 'chatgpt_crisis_talk', count: 8, platform: 'chatgpt', daysAgo: 1 },
      { entity: 'claude_general_support', count: 2, platform: 'claude', daysAgo: 6 }
    ],
    primaryMessages: [
      '[Claude] Hopeful conversation in Claude about progress',
      '[Claude] Claude talk focused on what\'s improving',
      '[Claude] Feeling optimistic in Claude discussion',
      '[Claude] That Claude chat gave me hope for healing'
    ],
    diverseMessages: {
      'chatgpt_crisis_talk': [
        '[ChatGPT] Crisis mode in ChatGPT yesterday',
        '[ChatGPT] ChatGPT conversation during panic',
        '[ChatGPT] Desperate feelings in ChatGPT talk',
        '[ChatGPT] ChatGPT helped through crisis moment',
        '[ChatGPT] Emergency support in ChatGPT',
        '[ChatGPT] That ChatGPT crisis conversation',
        '[ChatGPT] Suicidal ideation discussed in ChatGPT',
        '[ChatGPT] ChatGPT talked me through worst moment'
      ],
      'claude_general_support': [
        '[Claude] Regular check-ins in Claude',
        '[Claude] General emotional support'
      ]
    },
    expectedBehavior: 'Should prefer Claude hopeful (platform + emotional tone match)'
  },

  {
    num: 350,
    icp: 'companion',
    crossPlatformType: 'platform_clarification',
    name: 'Vague platform reference, infer from context',
    query: 'that conversation about my mother',
    queryPlatform: 'claude',
    primary: { entity: 'claude_mother_deep', count: 8, platform: 'claude', daysAgo: 1 },
    diverse: [
      { entity: 'chatgpt_mother_brief', count: 2, platform: 'chatgpt', daysAgo: 10 },
      { entity: 'claude_family_general', count: 2, platform: 'claude', daysAgo: 15 }
    ],
    primaryMessages: [
      '[Claude] Deep mother conversation in Claude yesterday',
      '[Claude] Processing mother wounds in Claude talk',
      '[Claude] Mother relationship analysis in Claude',
      '[Claude] Childhood with mother explored in Claude',
      '[Claude] Mother\'s emotional unavailability in Claude',
      '[Claude] That Claude mother conversation was intense',
      '[Claude] Understanding mother through Claude discussion',
      '[Claude] Mother patterns recognized in Claude'
    ],
    diverseMessages: {
      'chatgpt_mother_brief': [
        '[ChatGPT] Brief mother mention in ChatGPT',
        '[ChatGPT] Mother topic touched on in ChatGPT'
      ],
      'claude_family_general': [
        '[Claude] General family dynamics',
        '[Claude] Family patterns discussion'
      ]
    },
    expectedBehavior: 'Should prefer Claude (query platform + recency + depth)'
  }
];

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO GENERATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate candidates for a cross-platform scenario
 */
function generateCandidates(scenario) {
  const candidates = [];

  // ═══════════════════════════════════════════════════════════════════════
  // PRIMARY ENTITY (Expected Winner)
  // ═══════════════════════════════════════════════════════════════════════

  // Primary entity messages - should win most of the time
  // Base range: 0.20-0.27, with random variance ±0.02
  // Effective range with randomness: 0.18-0.29 (overlaps with diverse for realistic competition)
  scenario.primaryMessages.forEach((msg, idx) => {
    const platform = scenario.primary.platform;
    const relevance = 0.88 - idx * 0.015;
    const baseDistance = 0.20 + idx * 0.014;  // Base: 0.20-0.27
    const randomVariance = (Math.random() - 0.5) * 0.04;  // ±0.02 variance

    candidates.push({
      content: msg,
      entity: scenario.primary.entity,
      platform: platform,
      daysAgo: scenario.primary.daysAgo,
      embedding: genEmb(relevance, 0.78, platform),
      distance: baseDistance + randomVariance,  // With variance: 0.18-0.29
      ground_truth: 'primary'  // Mark for failure analysis
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DIVERSE ENTITIES (Different Competitors - Cross-Platform)
  // ═══════════════════════════════════════════════════════════════════════

  // Diverse entity messages from different platforms
  // Create realistic competition where sometimes diverse entity wins on distance
  scenario.diverse.forEach((diverse, diverseIdx) => {
    const messages = scenario.diverseMessages[diverse.entity];
    const platform = diverse.platform;

    messages.forEach((msg, msgIdx) => {
      // High similarity competitors: Distance range 0.23-0.31 (close to primary, overlaps slightly)
      // Medium similarity competitors: Distance range 0.30-0.40 (clearly worse)
      let baseDistance, distanceSpread;
      if (diverseIdx === 0) {
        // First diverse entity - high similarity competitor (same topic, different platform)
        baseDistance = 0.23;
        distanceSpread = 0.013;  // Range: 0.23-0.31
      } else {
        // Second diverse entity - medium similarity competitor
        baseDistance = 0.30;
        distanceSpread = 0.016;  // Range: 0.30-0.40
      }

      // Add moderate random noise to create realistic variance (±0.025)
      const randomVariance = (Math.random() - 0.5) * 0.05;  // ±0.025
      const diverseDistance = baseDistance + msgIdx * distanceSpread + randomVariance;

      candidates.push({
        content: msg,
        entity: diverse.entity,
        platform: platform,
        daysAgo: diverse.daysAgo,
        embedding: genEmb(0.82 - diverseIdx * 0.04 - msgIdx * 0.015, 0.68, platform),
        distance: diverseDistance,
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
 * Export all scenarios for Batch 7
 */
function generateBatch7Scenarios() {
  const allScenarios = [...developerScenarios, ...companionScenarios];

  return allScenarios.map(scenario => ({
    num: scenario.num,
    icp: scenario.icp,
    crossPlatformType: scenario.crossPlatformType,
    name: scenario.name,
    query: scenario.query,
    queryPlatform: scenario.queryPlatform,
    expectedPrimary: scenario.primary.entity,
    expectedDiverse: scenario.diverse.map(d => d.entity),
    candidates: generateCandidates(scenario),
    expectedBehavior: scenario.expectedBehavior
  }));
}

// Export for use in test runner
export { generateBatch7Scenarios, developerScenarios, companionScenarios };

// If run directly, output JSON
if (import.meta.url === `file://${process.argv[1]}`) {
  const scenarios = generateBatch7Scenarios();
  console.log(JSON.stringify(scenarios, null, 2));
}
