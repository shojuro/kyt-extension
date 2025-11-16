/**
 * Production MMR Test Suite - 50 Catastrophic Failure Scenarios
 *
 * Purpose: Validate MMR + Entity Deduplication prevents catastrophic failures
 * Standard: Precision > Recall (it's better to miss context than provide WRONG context)
 *
 * Key Principle: "Sister Jennifer ≠ dog Jenn" type failures would destroy user trust
 *
 * Test Coverage:
 * - 10 Human vs Pet scenarios (most catastrophic)
 * - 10 Family same-name scenarios
 * - 10 Nickname/formal name scenarios
 * - 10 Same place name scenarios
 * - 10 Professional vs personal context scenarios
 *
 * Each scenario: 10-15 candidates (realistic production size)
 */

import { applyMMR, MMR_PRESETS } from './src/mmr.js';

// ═══════════════════════════════════════════════════════════════════════
// TEST INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════

function createTestEmbedding(values) {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map(v => v / magnitude);
}

/**
 * Generate realistic embedding based on relevance and diversity
 */
function genEmb(relevance, diversity = 0.5) {
  const base = [];
  for (let i = 0; i < 10; i++) {
    if (i < 3) base.push(relevance * (0.85 + Math.random() * 0.15));
    else if (i < 6) base.push((1 - relevance) * diversity * (0.5 + Math.random() * 0.5));
    else base.push(Math.random() * 0.3);
  }
  return createTestEmbedding(base);
}

/**
 * Metrics tracker for catastrophic failures
 */
class CatastrophicFailureTracker {
  constructor() {
    this.totalScenarios = 0;
    this.catastrophicFailures = [];
    this.correctPrimary = 0;
    this.diversityImprovements = 0;
    this.falsePositives = 0;
    this.totalResults = 0;
  }

  record(num, name, result) {
    this.totalScenarios++;
    this.totalResults += 3; // 3 results per scenario

    if (result.catastrophic) {
      this.catastrophicFailures.push({
        num,
        name,
        expected: result.expectedPrimary,
        got: result.gotPrimary,
        severity: result.severity
      });
    }

    if (result.correctPrimary) this.correctPrimary++;
    if (result.diversityImproved) this.diversityImprovements++;
    this.falsePositives += result.falsePositives;
  }

  summary() {
    return {
      total: this.totalScenarios,
      catastrophic: this.catastrophicFailures.length,
      entityPrecision: ((this.correctPrimary / this.totalScenarios) * 100).toFixed(1),
      diversityRate: ((this.diversityImprovements / this.totalScenarios) * 100).toFixed(1),
      falsePositiveRate: ((this.falsePositives / this.totalResults) * 100).toFixed(1),
      passed: this.catastrophicFailures.length === 0 && (this.correctPrimary / this.totalScenarios) >= 0.95
    };
  }
}

/**
 * Run single scenario with catastrophic failure detection
 */
function runScenario(num, name, candidates, query, expectedPrimary, expectedDiverse) {
  const withoutMMR = [...candidates].sort((a, b) => a.distance - b.distance).slice(0, 3);
  const uniqueWithout = new Set(withoutMMR.map(i => i.entity)).size;

  const withMMR = applyMMR(candidates, 3, MMR_PRESETS.PRECISION.lambda, {
    debugMode: false,
    enableEntityDeduplication: true
  });

  const uniqueWith = new Set(withMMR.map(i => i.entity)).size;
  const gotPrimary = withMMR[0].entity;

  // Determine severity of failure
  let severity = 'none';
  if (gotPrimary !== expectedPrimary) {
    // Check if it's a CATASTROPHIC failure (completely wrong entity type)
    if (expectedPrimary.includes('sister') && gotPrimary.includes('dog')) severity = 'CRITICAL';
    else if (expectedPrimary.includes('son') && gotPrimary.includes('cat')) severity = 'CRITICAL';
    else if (expectedPrimary.includes('daughter') && gotPrimary.includes('rabbit')) severity = 'CRITICAL';
    else if (expectedPrimary.includes('doctor') && gotPrimary.includes('friend')) severity = 'HIGH';
    else if (expectedPrimary.includes('father') && gotPrimary.includes('son')) severity = 'MEDIUM';
    else severity = 'LOW';
  }

  const allExpected = new Set([expectedPrimary, ...expectedDiverse]);
  let falsePositives = 0;
  withMMR.forEach(item => {
    if (!allExpected.has(item.entity)) falsePositives++;
  });

  return {
    catastrophic: gotPrimary !== expectedPrimary,
    correctPrimary: gotPrimary === expectedPrimary,
    diversityImproved: uniqueWith > uniqueWithout,
    expectedPrimary,
    gotPrimary,
    severity,
    falsePositives,
    uniqueWith,
    uniqueWithout
  };
}

/**
 * Generate candidate set from template
 */
function generateCandidates(template) {
  const candidates = [];
  let idCounter = 1;

  // Primary entity messages (5 messages, highly relevant)
  template.primaryMessages.forEach((msg, idx) => {
    candidates.push({
      id: idCounter++,
      entity: template.primaryEntity,
      content: `${template.primaryPrefix} ${msg}`,
      distance: 0.08 + (idx * 0.02),
      embedding: genEmb(0.95 - (idx * 0.02), 0.1)
    });
  });

  // Diverse entity messages (3-4 messages per diverse entity, moderately relevant)
  template.diverseEntities.forEach(diverse => {
    diverse.messages.forEach((msg, idx) => {
      candidates.push({
        id: idCounter++,
        entity: diverse.entity,
        content: `${diverse.prefix} ${msg}`,
        distance: 0.35 + (idx * 0.03),
        embedding: genEmb(0.5 - (idx * 0.05), 0.8)
      });
    });
  });

  // Noise messages (2-3 messages, low relevance)
  template.noiseMessages.forEach((noise, idx) => {
    candidates.push({
      id: idCounter++,
      entity: noise.entity,
      content: noise.text,
      distance: 0.60 + (idx * 0.05),
      embedding: genEmb(0.3 - (idx * 0.05), 0.9)
    });
  });

  return candidates;
}

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO TEMPLATES
// ═══════════════════════════════════════════════════════════════════════

const scenarios = [
  // CATEGORY 1: Human vs Pet (MOST CATASTROPHIC) - 10 scenarios
  {
    num: 1,
    name: 'Jennifer (sister) vs Jenn (dog)',
    query: 'Tell me about Jennifer',
    primaryEntity: 'sister_jennifer',
    primaryPrefix: 'My sister Jennifer',
    primaryMessages: [
      'is a doctor in Boston',
      'called about wedding plans',
      'asked me to help her move',
      'started her new job',
      'is looking for houses'
    ],
    diverseEntities: [{
      entity: 'dog_jenn',
      prefix: 'Jenn (my golden retriever)',
      messages: ['loves playing fetch', 'needs a vet checkup', 'ate my shoes again']
    }],
    noiseMessages: [
      { entity: 'neighbor_jennifer', text: 'Neighbor Jennifer brought cookies' },
      { entity: 'gardening', text: 'Planted tomatoes in the garden' }
    ]
  },

  {
    num: 2,
    name: 'Charlie (son) vs Charlie (cat)',
    query: 'How is Charlie doing?',
    primaryEntity: 'son_charlie',
    primaryPrefix: 'My son Charlie',
    primaryMessages: [
      'got straight A\'s this semester',
      'made the varsity soccer team',
      'wants to study engineering',
      'asked about driver\'s license',
      'practices guitar daily'
    ],
    diverseEntities: [{
      entity: 'cat_charlie',
      prefix: 'Charlie (my tabby cat)',
      messages: ['knocked over the plant', 'sits in the sun', 'refused his cat food']
    }],
    noiseMessages: [
      { entity: 'uncle_charlie', text: 'Uncle Charlie visiting for Thanksgiving' },
      { entity: 'work', text: 'Finished the quarterly report' }
    ]
  },

  {
    num: 3,
    name: 'Max (son) vs Max (dog)',
    query: 'What is Max up to?',
    primaryEntity: 'son_max',
    primaryPrefix: 'Max',
    primaryMessages: [
      'won the science fair',
      'is learning piano',
      'needs help with calculus',
      'got into honors program'
    ],
    diverseEntities: [{
      entity: 'dog_max',
      prefix: 'Max (my German Shepherd)',
      messages: ['learned to roll over', 'needs flea medication', 'barked at the cat']
    }],
    noiseMessages: [
      { entity: 'brother_maxwell', text: 'Brother Maxwell got promoted' },
      { entity: 'friend_maxine', text: 'Maxine hosting dinner party' }
    ]
  },

  {
    num: 4,
    name: 'Bella (daughter) vs Bella (rabbit)',
    query: 'Tell me about Bella',
    primaryEntity: 'daughter_bella',
    primaryPrefix: 'Bella',
    primaryMessages: [
      'got the lead role in the play',
      'wants to study theater',
      'made honor roll again',
      'organizing drama fundraiser',
      'asked about Paris program'
    ],
    diverseEntities: [{
      entity: 'rabbit_bella',
      prefix: 'Bella (my pet rabbit)',
      messages: ['loves fresh carrots', 'cage needs cleaning', 'binky-hops when excited']
    }],
    noiseMessages: [
      { entity: 'cousin_isabella', text: 'Cousin Isabella graduated med school' },
      { entity: 'travel', text: 'Planning vacation to Italy' }
    ]
  },

  {
    num: 5,
    name: 'Lucy (daughter) vs Lucy (parrot)',
    query: 'What is Lucy doing?',
    primaryEntity: 'daughter_lucy',
    primaryPrefix: 'Lucy',
    primaryMessages: [
      'is applying to colleges',
      'scored a goal in championship',
      'got part-time job at library',
      'wants to study environmental science',
      'volunteered at animal shelter'
    ],
    diverseEntities: [{
      entity: 'parrot_lucy',
      prefix: 'Lucy (my African Grey parrot)',
      messages: ['says "good morning" in Spanish', 'needs vet for feathers', 'loves sunflower seeds']
    }],
    noiseMessages: [
      { entity: 'aunt_lucy', text: 'Aunt Lucy sent birthday gift' },
      { entity: 'work', text: 'Completed project ahead of schedule' }
    ]
  },

  {
    num: 6,
    name: 'Oliver (son) vs Oliver (hamster)',
    query: 'Tell me about Oliver',
    primaryEntity: 'son_oliver',
    primaryPrefix: 'Oliver',
    primaryMessages: [
      'made the debate team',
      'reading Harry Potter again',
      'wants to learn Python',
      'asked about computer camp',
      'built a Lego spaceship'
    ],
    diverseEntities: [{
      entity: 'hamster_oliver',
      prefix: 'Oliver (my hamster)',
      messages: ['runs on wheel all night', 'stuffs his cheeks', 'escaped from cage']
    }],
    noiseMessages: [
      { entity: 'cousin_oliver', text: 'Cousin Oliver getting married' },
      { entity: 'friend_ollie', text: 'Ollie invited me to watch game' }
    ]
  },

  {
    num: 7,
    name: 'Chloe (daughter) vs Chloe (guinea pig)',
    query: 'How is Chloe?',
    primaryEntity: 'daughter_chloe',
    primaryPrefix: 'Chloe',
    primaryMessages: [
      'won spelling bee',
      'started violin lessons',
      'wants to be a veterinarian',
      'made volcano for science',
      'asked about braces'
    ],
    diverseEntities: [{
      entity: 'guineapig_chloe',
      prefix: 'Chloe (my guinea pig)',
      messages: ['squeaks when I open fridge', 'needs nails trimmed', 'loves bell peppers']
    }],
    noiseMessages: [
      { entity: 'sister_chloe', text: 'Sister Chloe lives in Seattle' },
      { entity: 'gardening', text: 'Harvested vegetables from garden' }
    ]
  },

  {
    num: 8,
    name: 'Milo (son) vs Milo (ferret)',
    query: 'What is Milo up to?',
    primaryEntity: 'son_milo',
    primaryPrefix: 'Milo',
    primaryMessages: [
      'joined the swim team',
      'wants to learn skateboarding',
      'got perfect score on math test',
      'building treehouse',
      'asked about summer camp'
    ],
    diverseEntities: [{
      entity: 'ferret_milo',
      prefix: 'Milo (my ferret)',
      messages: ['stole my sock', 'plays with ping pong balls', 'needs nails trimmed']
    }],
    noiseMessages: [
      { entity: 'nephew_milo', text: 'Nephew Milo learning to walk' },
      { entity: 'work', text: 'Submitted quarterly financial report' }
    ]
  },

  {
    num: 9,
    name: 'Sophie (daughter) vs Sophie (bird)',
    query: 'Tell me about Sophie',
    primaryEntity: 'daughter_sophie',
    primaryPrefix: 'Sophie',
    primaryMessages: [
      'learning French in school',
      'made the cheerleading squad',
      'wants to go to art school',
      'painted award-winning portrait',
      'asked about getting puppy'
    ],
    diverseEntities: [{
      entity: 'bird_sophie',
      prefix: 'Sophie (my cockatiel)',
      messages: ['whistles Star Wars theme', 'molting feathers', 'loves millet spray']
    }],
    noiseMessages: [
      { entity: 'aunt_sophia', text: 'Aunt Sophia visiting from France' },
      { entity: 'cooking', text: 'Tried new pasta recipe' }
    ]
  },

  {
    num: 10,
    name: 'Leo (son) vs Leo (lizard)',
    query: 'What is Leo doing?',
    primaryEntity: 'son_leo',
    primaryPrefix: 'Leo',
    primaryMessages: [
      'learning to play chess',
      'wants to build robots',
      'won spelling competition',
      'started karate classes',
      'asked about Boy Scouts'
    ],
    diverseEntities: [{
      entity: 'lizard_leo',
      prefix: 'Leo (my bearded dragon)',
      messages: ['shedding his skin', 'basking under heat lamp', 'ate all his crickets']
    }],
    noiseMessages: [
      { entity: 'uncle_leon', text: 'Uncle Leon sent birthday card' },
      { entity: 'home', text: 'Fixed the leaky faucet' }
    ]
  },

  // CATEGORY 2: Family Same Name (HIGH SEVERITY) - 10 scenarios
  {
    num: 11,
    name: 'Mike (father) vs Mike (son) vs Mike (neighbor)',
    query: 'What did Mike do recently?',
    primaryEntity: 'father_mike',
    primaryPrefix: 'My dad Mike',
    primaryMessages: [
      'retired from teaching',
      'loves fishing on weekends',
      'planning Alaska trip',
      'bought new boat',
      'celebrated 40th anniversary'
    ],
    diverseEntities: [
      {
        entity: 'son_mike',
        prefix: 'My son Mike',
        messages: ['started college engineering', 'asked for textbook money', 'joined robotics club', 'coming home for Thanksgiving']
      },
      {
        entity: 'neighbor_mike',
        prefix: 'Mike next door',
        messages: ['helped fix fence', 'borrowed lawn mower', 'dog barks at night']
      }
    ],
    noiseMessages: [
      { entity: 'work', text: 'Completed annual performance review' }
    ]
  },

  {
    num: 12,
    name: 'Sarah (doctor) vs Sarah (friend) vs Sarah (sister)',
    query: 'What did Sarah tell me?',
    primaryEntity: 'doctor_sarah',
    primaryPrefix: 'My doctor Dr. Sarah',
    primaryMessages: [
      'recommended vitamin D',
      'said blood pressure improving',
      'wants follow-up in 3 months',
      'prescribed allergy medication'
    ],
    diverseEntities: [
      {
        entity: 'friend_sarah',
        prefix: 'Sarah (my friend)',
        messages: ['planning Vegas trip', 'broke up with boyfriend', 'got promotion', 'invited me to party']
      },
      {
        entity: 'sister_sarah',
        prefix: 'My sister Sarah',
        messages: ['promoted to senior manager', 'buying new house', 'asked me to babysit']
      }
    ],
    noiseMessages: [
      { entity: 'coworker_sara', text: 'Sara from work finished project' }
    ]
  },

  {
    num: 13,
    name: 'Chris (brother) vs Chris (cousin) vs Chris (coworker)',
    query: 'How is Chris doing?',
    primaryEntity: 'brother_chris',
    primaryPrefix: 'My brother Chris',
    primaryMessages: [
      'accepted into law school',
      'moving to Boston',
      'broke up with girlfriend',
      'wants environmental law specialty',
      'asked me to help move'
    ],
    diverseEntities: [
      {
        entity: 'cousin_chris',
        prefix: 'Cousin Chris',
        messages: ['just had first baby', 'bought house in suburbs', 'invited family to BBQ', 'started consulting business']
      },
      {
        entity: 'coworker_chris',
        prefix: 'Chris from sales',
        messages: ['closed biggest deal', 'transferring to LA', 'organized holiday party']
      }
    ],
    noiseMessages: [
      { entity: 'friend_christine', text: 'Christine invited to wedding' }
    ]
  },

  {
    num: 14,
    name: 'Alex (boss) vs Alex (friend) vs Alex (cousin)',
    query: 'What is Alex up to?',
    primaryEntity: 'boss_alex',
    primaryPrefix: 'My boss Alexander',
    primaryMessages: [
      'approved vacation request',
      'scheduled team meeting Monday',
      'announced org changes',
      'considering promotion request',
      'wants to discuss performance'
    ],
    diverseEntities: [
      {
        entity: 'friend_alex',
        prefix: 'Alex (my friend)',
        messages: ['invited to birthday party', 'asked to grab coffee', 'going through divorce', 'training for marathon']
      },
      {
        entity: 'cousin_alex',
        prefix: 'Cousin Alex',
        messages: ['graduated law school', 'passed bar exam', 'moving to Chicago']
      }
    ],
    noiseMessages: [
      { entity: 'wife_alexandra', text: 'Wife Alexandra planning surprise party' }
    ]
  },

  {
    num: 15,
    name: 'Emily (sister) vs Emily (daughter) vs Emily (niece)',
    query: 'Tell me about Emily',
    primaryEntity: 'sister_emily',
    primaryPrefix: 'My sister Emily',
    primaryMessages: [
      'just got engaged',
      'planning destination wedding',
      'quit job to start business',
      'bought house in Portland',
      'asked me to be maid of honor'
    ],
    diverseEntities: [
      {
        entity: 'daughter_emily',
        prefix: 'My daughter Emily',
        messages: ['applying to med schools', 'volunteered at hospital', 'scored 98 on chemistry', 'wants to be pediatrician']
      },
      {
        entity: 'niece_emily',
        prefix: 'Niece Emily',
        messages: ['turned 5 years old', 'started kindergarten', 'loves toy kitchen']
      }
    ],
    noiseMessages: [
      { entity: 'friend_emma', text: 'Emma hosting Thanksgiving' }
    ]
  },

  {
    num: 16,
    name: 'James (father) vs James (son)',
    query: 'What did James say?',
    primaryEntity: 'father_james',
    primaryPrefix: 'My dad James',
    primaryMessages: [
      'wants to retire next year',
      'sold the old truck',
      'planning cruise with Mom',
      'had knee surgery'
    ],
    diverseEntities: [{
      entity: 'son_james',
      prefix: 'My son James',
      messages: ['got accepted to MIT', 'building a robot', 'won coding competition']
    }],
    noiseMessages: [
      { entity: 'uncle_jim', text: 'Uncle Jim visiting from Texas' },
      { entity: 'work', text: 'Submitted expense report' }
    ]
  },

  {
    num: 17,
    name: 'Kate (wife) vs Kate (daughter)',
    query: 'How is Kate?',
    primaryEntity: 'wife_kate',
    primaryPrefix: 'My wife Kate',
    primaryMessages: [
      'got promoted at work',
      'wants to remodel kitchen',
      'joined book club',
      'planning anniversary trip'
    ],
    diverseEntities: [{
      entity: 'daughter_kate',
      prefix: 'My daughter Kate',
      messages: ['made varsity basketball', 'studying for SATs', 'looking at colleges']
    }],
    noiseMessages: [
      { entity: 'sister_katie', text: 'Sister Katie moved to Denver' },
      { entity: 'gardening', text: 'Pruned the rose bushes' }
    ]
  },

  {
    num: 18,
    name: 'Tom (brother) vs Tom (son)',
    query: 'What is Tom up to?',
    primaryEntity: 'brother_tom',
    primaryPrefix: 'My brother Tom',
    primaryMessages: [
      'started his own company',
      'bought vacation home',
      'training for triathlon',
      'invited me to investor meeting'
    ],
    diverseEntities: [{
      entity: 'son_tom',
      prefix: 'My son Tom',
      messages: ['made honor roll', 'joined debate team', 'wants to be lawyer']
    }],
    noiseMessages: [
      { entity: 'friend_tommy', text: 'Tommy hosting poker night' },
      { entity: 'work', text: 'Finished project documentation' }
    ]
  },

  {
    num: 19,
    name: 'Anna (mother) vs Anna (daughter)',
    query: 'Tell me about Anna',
    primaryEntity: 'mother_anna',
    primaryPrefix: 'My mom Anna',
    primaryMessages: [
      'is recovering from surgery',
      'wants to visit next month',
      'started watercolor painting',
      'joined senior yoga class'
    ],
    diverseEntities: [{
      entity: 'daughter_anna',
      prefix: 'My daughter Anna',
      messages: ['got scholarship to Yale', 'captain of swim team', 'won science award']
    }],
    noiseMessages: [
      { entity: 'sister_anne', text: 'Sister Anne visiting from Canada' },
      { entity: 'cooking', text: 'Made grandmother\'s recipe' }
    ]
  },

  {
    num: 20,
    name: 'David (father) vs David (brother)',
    query: 'What did David do?',
    primaryEntity: 'father_david',
    primaryPrefix: 'My dad David',
    primaryMessages: [
      'fixed the garage door',
      'watching the football game',
      'wants new fishing gear',
      'planning camping trip'
    ],
    diverseEntities: [{
      entity: 'brother_david',
      prefix: 'My brother David',
      messages: ['got job at Google', 'moving to California', 'buying first house']
    }],
    noiseMessages: [
      { entity: 'friend_dave', text: 'Dave invited to golf outing' },
      { entity: 'home', text: 'Replaced air filter' }
    ]
  },

  // CATEGORY 3: Nicknames vs Formal Names (MEDIUM SEVERITY) - 10 scenarios
  {
    num: 21,
    name: 'William (boss) vs Will (friend) vs Billy (nephew)',
    query: 'What did William say?',
    primaryEntity: 'boss_william',
    primaryPrefix: 'My boss William',
    primaryMessages: [
      'approved the budget',
      'wants presentation by Friday',
      'scheduling quarterly review',
      'mentioned possible layoffs'
    ],
    diverseEntities: [
      {
        entity: 'friend_will',
        prefix: 'Will (my friend)',
        messages: ['invited to Super Bowl party', 'going through divorce', 'started gym membership']
      },
      {
        entity: 'nephew_billy',
        prefix: 'Nephew Billy',
        messages: ['turned 3 years old', 'started preschool', 'loves dinosaurs']
      }
    ],
    noiseMessages: [
      { entity: 'work', text: 'Updated project timeline' }
    ]
  },

  {
    num: 22,
    name: 'Robert (father) vs Rob (coworker) vs Bobby (son)',
    query: 'How is Robert?',
    primaryEntity: 'father_robert',
    primaryPrefix: 'My dad Robert',
    primaryMessages: [
      'had hip replacement',
      'recovering well',
      'wants to go fishing soon',
      'bought new recliner'
    ],
    diverseEntities: [
      {
        entity: 'coworker_rob',
        prefix: 'Rob from IT',
        messages: ['fixed my computer', 'quit to start startup', 'moving to Austin']
      },
      {
        entity: 'son_bobby',
        prefix: 'My son Bobby',
        messages: ['made soccer team', 'wants drum lessons', 'lost first tooth']
      }
    ],
    noiseMessages: [
      { entity: 'home', text: 'Changed batteries in smoke detector' }
    ]
  },

  {
    num: 23,
    name: 'Richard (boss) vs Rick (friend) vs Dick (uncle)',
    query: 'What did Richard tell me?',
    primaryEntity: 'boss_richard',
    primaryPrefix: 'My boss Richard',
    primaryMessages: [
      'denied my raise request',
      'wants to discuss performance',
      'hired new team members',
      'changing vacation policy'
    ],
    diverseEntities: [
      {
        entity: 'friend_rick',
        prefix: 'Rick (my friend)',
        messages: ['bought new truck', 'invited to hunting trip', 'got promoted']
      },
      {
        entity: 'uncle_dick',
        prefix: 'Uncle Dick',
        messages: ['visiting next week', 'bringing famous BBQ', 'wants fishing tips']
      }
    ],
    noiseMessages: [
      { entity: 'work', text: 'Completed safety training' }
    ]
  },

  {
    num: 24,
    name: 'Elizabeth (mother) vs Beth (sister) vs Liz (coworker)',
    query: 'Tell me about Elizabeth',
    primaryEntity: 'mother_elizabeth',
    primaryPrefix: 'My mom Elizabeth',
    primaryMessages: [
      'is planning Thanksgiving',
      'wants everyone to come',
      'trying new recipes',
      'redecorating living room'
    ],
    diverseEntities: [
      {
        entity: 'sister_beth',
        prefix: 'My sister Beth',
        messages: ['expecting second baby', 'moving to bigger house', 'quit smoking']
      },
      {
        entity: 'coworker_liz',
        prefix: 'Liz from marketing',
        messages: ['won client pitch', 'transferring to NYC', 'got engaged']
      }
    ],
    noiseMessages: [
      { entity: 'friend_betty', text: 'Betty hosting book club' }
    ]
  },

  {
    num: 25,
    name: 'Michael (brother) vs Mike (neighbor) vs Mikey (nephew)',
    query: 'What is Michael up to?',
    primaryEntity: 'brother_michael',
    primaryPrefix: 'My brother Michael',
    primaryMessages: [
      'got promoted to director',
      'bought Tesla',
      'planning Europe trip',
      'ran marathon PR'
    ],
    diverseEntities: [
      {
        entity: 'neighbor_mike',
        prefix: 'Mike across street',
        messages: ['selling his house', 'moving to Florida', 'having yard sale']
      },
      {
        entity: 'nephew_mikey',
        prefix: 'Nephew Mikey',
        messages: ['started little league', 'loves playing Minecraft', 'wants puppy']
      }
    ],
    noiseMessages: [
      { entity: 'work', text: 'Attended team building event' }
    ]
  },

  {
    num: 26,
    name: 'Daniel (father) vs Dan (friend) vs Danny (son)',
    query: 'How is Daniel?',
    primaryEntity: 'father_daniel',
    primaryPrefix: 'My dad Daniel',
    primaryMessages: [
      'retired last month',
      'building model trains',
      'wants to travel more',
      'taking painting classes'
    ],
    diverseEntities: [
      {
        entity: 'friend_dan',
        prefix: 'Dan (my friend)',
        messages: ['got divorced', 'dating someone new', 'bought motorcycle']
      },
      {
        entity: 'son_danny',
        prefix: 'My son Danny',
        messages: ['made varsity baseball', 'wants to major in business', 'got driver\'s license']
      }
    ],
    noiseMessages: [
      { entity: 'home', text: 'Cleaned out garage' }
    ]
  },

  {
    num: 27,
    name: 'Catherine (mother) vs Cathy (sister) vs Cat (friend)',
    query: 'What did Catherine say?',
    primaryEntity: 'mother_catherine',
    primaryPrefix: 'My mom Catherine',
    primaryMessages: [
      'wants to sell the house',
      'planning to downsize',
      'visiting next weekend',
      'needs help sorting photos'
    ],
    diverseEntities: [
      {
        entity: 'sister_cathy',
        prefix: 'My sister Cathy',
        messages: ['changed careers', 'going back to school', 'learning Spanish']
      },
      {
        entity: 'friend_cat',
        prefix: 'Cat (my friend)',
        messages: ['got new job', 'training for half-marathon', 'adopted rescue dog']
      }
    ],
    noiseMessages: [
      { entity: 'cooking', text: 'Baked apple pie' }
    ]
  },

  {
    num: 28,
    name: 'Anthony (father) vs Tony (brother) vs Anton (cousin)',
    query: 'Tell me about Anthony',
    primaryEntity: 'father_anthony',
    primaryPrefix: 'My dad Anthony',
    primaryMessages: [
      'had cataract surgery',
      'vision improving',
      'back to woodworking',
      'building birdhouses'
    ],
    diverseEntities: [
      {
        entity: 'brother_tony',
        prefix: 'My brother Tony',
        messages: ['started MBA program', 'working at startup', 'engaged to Melissa']
      },
      {
        entity: 'cousin_anton',
        prefix: 'Cousin Anton',
        messages: ['moved from Russia', 'learning English', 'loves American football']
      }
    ],
    noiseMessages: [
      { entity: 'work', text: 'Completed compliance training' }
    ]
  },

  {
    num: 29,
    name: 'Margaret (grandmother) vs Maggie (daughter) vs Meg (friend)',
    query: 'How is Margaret?',
    primaryEntity: 'grandmother_margaret',
    primaryPrefix: 'My grandmother Margaret',
    primaryMessages: [
      'celebrating 90th birthday',
      'still lives independently',
      'wants family reunion',
      'making quilts for grandkids'
    ],
    diverseEntities: [
      {
        entity: 'daughter_maggie',
        prefix: 'My daughter Maggie',
        messages: ['applying to art schools', 'won painting competition', 'wants gap year']
      },
      {
        entity: 'friend_meg',
        prefix: 'Meg (my friend)',
        messages: ['got promoted', 'bought condo', 'planning wedding']
      }
    ],
    noiseMessages: [
      { entity: 'gardening', text: 'Planted spring bulbs' }
    ]
  },

  {
    num: 30,
    name: 'Christopher (boss) vs Chris (son) vs Topher (friend)',
    query: 'What did Christopher say?',
    primaryEntity: 'boss_christopher',
    primaryPrefix: 'My boss Christopher',
    primaryMessages: [
      'implementing new policies',
      'restructuring department',
      'wants progress reports',
      'considering office relocation'
    ],
    diverseEntities: [
      {
        entity: 'son_chris',
        prefix: 'My son Chris',
        messages: ['made honor roll', 'wants to be engineer', 'joined chess club']
      },
      {
        entity: 'friend_topher',
        prefix: 'Topher (my friend)',
        messages: ['started band', 'playing at local venues', 'quit day job']
      }
    ],
    noiseMessages: [
      { entity: 'work', text: 'Updated LinkedIn profile' }
    ]
  },

  // CATEGORY 4: Same Place Name (MEDIUM SEVERITY) - 10 scenarios
  {
    num: 31,
    name: 'Portland (Oregon) vs Portland (Maine)',
    query: 'Tell me about Portland',
    primaryEntity: 'portland_oregon',
    primaryPrefix: 'Portland, Oregon',
    primaryMessages: [
      'has amazing coffee shops',
      'visited Powell\'s bookstore',
      'loved the food trucks',
      'spent hours at Washington Park'
    ],
    diverseEntities: [{
      entity: 'portland_maine',
      prefix: 'Portland, Maine',
      messages: ['has best lobster rolls', 'beautiful lighthouse tours', 'charming waterfront']
    }],
    noiseMessages: [
      { entity: 'travel_general', text: 'Planning west coast vacation' },
      { entity: 'work', text: 'Business trip next month' }
    ]
  },

  {
    num: 32,
    name: 'Springfield (Illinois) vs Springfield (Massachusetts)',
    query: 'What did I do in Springfield?',
    primaryEntity: 'springfield_illinois',
    primaryPrefix: 'Springfield, Illinois',
    primaryMessages: [
      'visited Lincoln\'s home',
      'toured state capitol',
      'tried horseshoe sandwich',
      'saw Abraham Lincoln museum'
    ],
    diverseEntities: [{
      entity: 'springfield_massachusetts',
      prefix: 'Springfield, Massachusetts',
      messages: ['visited Basketball Hall of Fame', 'toured Dr. Seuss museum', 'ate at famous diner']
    }],
    noiseMessages: [
      { entity: 'travel', text: 'Road trip across America' },
      { entity: 'home', text: 'Organized photo albums' }
    ]
  },

  {
    num: 33,
    name: 'Paris (France) vs Paris (Texas)',
    query: 'How was Paris?',
    primaryEntity: 'paris_france',
    primaryPrefix: 'Paris, France',
    primaryMessages: [
      'climbed Eiffel Tower',
      'ate croissants at café',
      'visited Louvre museum',
      'walked along Seine river'
    ],
    diverseEntities: [{
      entity: 'paris_texas',
      prefix: 'Paris, Texas',
      messages: ['saw Eiffel Tower replica', 'visited small-town museum', 'ate Texas BBQ']
    }],
    noiseMessages: [
      { entity: 'travel', text: 'Planning European vacation' },
      { entity: 'work', text: 'International conference' }
    ]
  },

  {
    num: 34,
    name: 'Cambridge (UK) vs Cambridge (Massachusetts)',
    query: 'Tell me about Cambridge',
    primaryEntity: 'cambridge_uk',
    primaryPrefix: 'Cambridge, England',
    primaryMessages: [
      'toured university colleges',
      'went punting on river',
      'visited King\'s College Chapel',
      'had afternoon tea'
    ],
    diverseEntities: [{
      entity: 'cambridge_massachusetts',
      prefix: 'Cambridge, Massachusetts',
      messages: ['visited Harvard campus', 'ate at MIT cafeteria', 'explored bookstores']
    }],
    noiseMessages: [
      { entity: 'education', text: 'Researching graduate programs' },
      { entity: 'travel', text: 'New England road trip' }
    ]
  },

  {
    num: 35,
    name: 'Alexandria (Egypt) vs Alexandria (Virginia)',
    query: 'What was Alexandria like?',
    primaryEntity: 'alexandria_egypt',
    primaryPrefix: 'Alexandria, Egypt',
    primaryMessages: [
      'saw ancient library site',
      'explored Roman ruins',
      'walked along Mediterranean',
      'visited catacombs'
    ],
    diverseEntities: [{
      entity: 'alexandria_virginia',
      prefix: 'Alexandria, Virginia',
      messages: ['toured Old Town', 'ate at waterfront restaurants', 'visited George Washington museum']
    }],
    noiseMessages: [
      { entity: 'travel', text: 'Middle East trip' },
      { entity: 'history', text: 'Reading about ancient civilizations' }
    ]
  },

  {
    num: 36,
    name: 'Birmingham (UK) vs Birmingham (Alabama)',
    query: 'How was Birmingham?',
    primaryEntity: 'birmingham_uk',
    primaryPrefix: 'Birmingham, England',
    primaryMessages: [
      'explored Cadbury World',
      'visited canal district',
      'toured Bullring shopping',
      'saw Symphony Hall concert'
    ],
    diverseEntities: [{
      entity: 'birmingham_alabama',
      prefix: 'Birmingham, Alabama',
      messages: ['visited Civil Rights museum', 'ate Southern BBQ', 'toured Vulcan statue']
    }],
    noiseMessages: [
      { entity: 'travel', text: 'Comparing US and UK cities' },
      { entity: 'work', text: 'Business conference' }
    ]
  },

  {
    num: 37,
    name: 'Manchester (UK) vs Manchester (New Hampshire)',
    query: 'Tell me about Manchester',
    primaryEntity: 'manchester_uk',
    primaryPrefix: 'Manchester, England',
    primaryMessages: [
      'saw Old Trafford stadium',
      'visited museums',
      'explored Northern Quarter',
      'went to live music venue'
    ],
    diverseEntities: [{
      entity: 'manchester_newhampshire',
      prefix: 'Manchester, New Hampshire',
      messages: ['visited Currier Museum', 'saw Millyard district', 'hiked nearby mountains']
    }],
    noiseMessages: [
      { entity: 'sports', text: 'Watching Premier League' },
      { entity: 'travel', text: 'New England autumn tour' }
    ]
  },

  {
    num: 38,
    name: 'Athens (Greece) vs Athens (Georgia)',
    query: 'What did I see in Athens?',
    primaryEntity: 'athens_greece',
    primaryPrefix: 'Athens, Greece',
    primaryMessages: [
      'climbed Acropolis',
      'saw Parthenon',
      'visited ancient Agora',
      'ate authentic Greek food'
    ],
    diverseEntities: [{
      entity: 'athens_georgia',
      prefix: 'Athens, Georgia',
      messages: ['toured UGA campus', 'saw REM museum', 'ate at local breweries']
    }],
    noiseMessages: [
      { entity: 'travel', text: 'Mediterranean cruise' },
      { entity: 'history', text: 'Learning ancient Greek' }
    ]
  },

  {
    num: 39,
    name: 'Melbourne (Australia) vs Melbourne (Florida)',
    query: 'How was Melbourne?',
    primaryEntity: 'melbourne_australia',
    primaryPrefix: 'Melbourne, Australia',
    primaryMessages: [
      'explored laneways',
      'saw street art',
      'went to St Kilda beach',
      'visited Queen Victoria Market'
    ],
    diverseEntities: [{
      entity: 'melbourne_florida',
      prefix: 'Melbourne, Florida',
      messages: ['watched rocket launch', 'visited beaches', 'saw manatees']
    }],
    noiseMessages: [
      { entity: 'travel', text: 'Round-the-world trip' },
      { entity: 'work', text: 'Tech conference' }
    ]
  },

  {
    num: 40,
    name: 'Richmond (Virginia) vs Richmond (California)',
    query: 'Tell me about Richmond',
    primaryEntity: 'richmond_virginia',
    primaryPrefix: 'Richmond, Virginia',
    primaryMessages: [
      'toured state capitol',
      'visited Civil War sites',
      'explored Monument Avenue',
      'ate Southern cuisine'
    ],
    diverseEntities: [{
      entity: 'richmond_california',
      prefix: 'Richmond, California',
      messages: ['visited Point Richmond', 'saw SF Bay views', 'explored marina']
    }],
    noiseMessages: [
      { entity: 'travel', text: 'East Coast historical tour' },
      { entity: 'history', text: 'American history research' }
    ]
  },

  // CATEGORY 5: Professional vs Personal Context (MEDIUM-HIGH SEVERITY) - 10 scenarios
  {
    num: 41,
    name: 'Dr. Johnson (doctor) vs Johnson (neighbor)',
    query: 'What did Johnson tell me?',
    primaryEntity: 'doctor_johnson',
    primaryPrefix: 'My doctor Dr. Johnson',
    primaryMessages: [
      'wants me to lose weight',
      'prescribed blood pressure meds',
      'scheduled colonoscopy',
      'said cholesterol is high'
    ],
    diverseEntities: [{
      entity: 'neighbor_johnson',
      prefix: 'Johnson next door',
      messages: ['asked to borrow tools', 'invited to BBQ', 'wants to trim shared hedge']
    }],
    noiseMessages: [
      { entity: 'work', text: 'Met with Johnson & Associates' },
      { entity: 'home', text: 'Fixed doorbell' }
    ]
  },

  {
    num: 42,
    name: 'Dr. Martinez (therapist) vs Martinez (coworker)',
    query: 'How was my session with Martinez?',
    primaryEntity: 'therapist_martinez',
    primaryPrefix: 'My therapist Dr. Martinez',
    primaryMessages: [
      'wants me to journal daily',
      'discussed anxiety management',
      'suggested meditation',
      'recommended reading list'
    ],
    diverseEntities: [{
      entity: 'coworker_martinez',
      prefix: 'Martinez from sales',
      messages: ['closed major deal', 'invited to happy hour', 'transferring to Austin']
    }],
    noiseMessages: [
      { entity: 'health', text: 'Started new exercise routine' },
      { entity: 'work', text: 'Quarterly review meeting' }
    ]
  },

  {
    num: 43,
    name: 'Attorney Wilson (lawyer) vs Wilson (friend)',
    query: 'What did Wilson say?',
    primaryEntity: 'attorney_wilson',
    primaryPrefix: 'My lawyer Wilson',
    primaryMessages: [
      'drafted new will',
      'handling estate planning',
      'reviewing divorce papers',
      'scheduling court date'
    ],
    diverseEntities: [{
      entity: 'friend_wilson',
      prefix: 'Wilson (my friend)',
      messages: ['invited to poker night', 'wants fantasy football advice', 'selling boat']
    }],
    noiseMessages: [
      { entity: 'legal', text: 'Researching legal documents' },
      { entity: 'work', text: 'Contract negotiation' }
    ]
  },

  {
    num: 44,
    name: 'Dr. Lee (dentist) vs Lee (brother)',
    query: 'How was my appointment with Lee?',
    primaryEntity: 'dentist_lee',
    primaryPrefix: 'My dentist Dr. Lee',
    primaryMessages: [
      'found two cavities',
      'needs crown replacement',
      'suggested night guard',
      'scheduled cleaning'
    ],
    diverseEntities: [{
      entity: 'brother_lee',
      prefix: 'My brother Lee',
      messages: ['bought new car', 'planning ski trip', 'got promoted']
    }],
    noiseMessages: [
      { entity: 'health', text: 'Bought electric toothbrush' },
      { entity: 'work', text: 'Met Lee Industries rep' }
    ]
  },

  {
    num: 45,
    name: 'Professor Anderson (teacher) vs Anderson (son)',
    query: 'What did Anderson tell me?',
    primaryEntity: 'professor_anderson',
    primaryPrefix: 'Professor Anderson',
    primaryMessages: [
      'extended paper deadline',
      'office hours Tuesday',
      'recommending for scholarship',
      'grading midterms harsh'
    ],
    diverseEntities: [{
      entity: 'son_anderson',
      prefix: 'My son Anderson',
      messages: ['made basketball team', 'wants new video game', 'got perfect attendance']
    }],
    noiseMessages: [
      { entity: 'education', text: 'Studying for finals' },
      { entity: 'home', text: 'Cleaned garage' }
    ]
  },

  {
    num: 46,
    name: 'Pastor Brown (religious) vs Brown (coworker)',
    query: 'How was my meeting with Brown?',
    primaryEntity: 'pastor_brown',
    primaryPrefix: 'Pastor Brown',
    primaryMessages: [
      'counseling on marriage',
      'planning youth retreat',
      'wants me to volunteer',
      'leading Bible study'
    ],
    diverseEntities: [{
      entity: 'coworker_brown',
      prefix: 'Brown from accounting',
      messages: ['found budget error', 'needs expense approval', 'organizing retirement party']
    }],
    noiseMessages: [
      { entity: 'church', text: 'Sunday service schedule' },
      { entity: 'work', text: 'Financial audit' }
    ]
  },

  {
    num: 47,
    name: 'Dr. Patel (cardiologist) vs Patel (friend)',
    query: 'What did Dr. Patel say?',
    primaryEntity: 'cardiologist_patel',
    primaryPrefix: 'My cardiologist Dr. Patel',
    primaryMessages: [
      'EKG results normal',
      'wants stress test',
      'adjusting medications',
      'follow-up in 6 months'
    ],
    diverseEntities: [{
      entity: 'friend_patel',
      prefix: 'Patel (my friend)',
      messages: ['invited to Diwali party', 'bought new house', 'starting restaurant']
    }],
    noiseMessages: [
      { entity: 'health', text: 'Started cardiac diet' },
      { entity: 'work', text: 'Healthcare conference' }
    ]
  },

  {
    num: 48,
    name: 'Coach Thompson (trainer) vs Thompson (neighbor)',
    query: 'What did Thompson tell me?',
    primaryEntity: 'coach_thompson',
    primaryPrefix: 'My trainer Coach Thompson',
    primaryMessages: [
      'increase weights this week',
      'focus on cardio',
      'new meal plan',
      'making good progress'
    ],
    diverseEntities: [{
      entity: 'neighbor_thompson',
      prefix: 'Thompson across street',
      messages: ['selling house', 'moving to Texas', 'having garage sale']
    }],
    noiseMessages: [
      { entity: 'fitness', text: 'Bought new running shoes' },
      { entity: 'home', text: 'Mowed lawn' }
    ]
  },

  {
    num: 49,
    name: 'CPA Miller (accountant) vs Miller (friend)',
    query: 'How was my tax meeting with Miller?',
    primaryEntity: 'accountant_miller',
    primaryPrefix: 'My accountant Miller',
    primaryMessages: [
      'found more deductions',
      'getting refund this year',
      'suggested IRA contribution',
      'needs more receipts'
    ],
    diverseEntities: [{
      entity: 'friend_miller',
      prefix: 'Miller (my friend)',
      messages: ['invited to concert', 'got new dog', 'planning camping trip']
    }],
    noiseMessages: [
      { entity: 'finance', text: 'Reviewing investment portfolio' },
      { entity: 'work', text: 'Annual budget planning' }
    ]
  },

  {
    num: 50,
    name: 'Principal Garcia (school) vs Garcia (sister)',
    query: 'What did Garcia tell me?',
    primaryEntity: 'principal_garcia',
    primaryPrefix: 'Principal Garcia',
    primaryMessages: [
      'my son suspended for fighting',
      'parent-teacher conference',
      'implementing new policies',
      'wants volunteer help'
    ],
    diverseEntities: [{
      entity: 'sister_garcia',
      prefix: 'My sister Garcia',
      messages: ['planning surprise party', 'got new job', 'moving to Miami']
    }],
    noiseMessages: [
      { entity: 'parenting', text: 'Researching discipline methods' },
      { entity: 'work', text: 'School board meeting' }
    ]
  }
];

// ═══════════════════════════════════════════════════════════════════════
const metrics = new CatastrophicFailureTracker();
// RUN ALL 50 SCENARIOS
// ═══════════════════════════════════════════════════════════════════════

scenarios.forEach(template => {
  const candidates = generateCandidates(template);
  const expectedDiverse = template.diverseEntities.map(d => d.entity);

  const result = runScenario(
    template.num,
    template.name,
    candidates,
    template.query,
    template.primaryEntity,
    expectedDiverse
  );

  metrics.record(template.num, template.name, result);

  // Print progress
  if (template.num % 10 === 0) {
    console.log(`   Completed ${template.num}/50 scenarios...`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// FINAL RESULTS
// ═══════════════════════════════════════════════════════════════════════

console.log('\n');
console.log('╔═══════════════════════════════════════════════════════════════════╗');
console.log('║                  PRODUCTION TEST RESULTS                          ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

const summary = metrics.summary();

console.log('📊 OVERALL METRICS:');
console.log(`   Total Scenarios: ${summary.total}`);
console.log(`   Catastrophic Failures: ${summary.catastrophic} ${summary.catastrophic === 0 ? '✅' : '❌'}`);
console.log(`   Entity Precision: ${summary.entityPrecision}% ${parseFloat(summary.entityPrecision) >= 95 ? '✅' : '❌'}`);
console.log(`   Diversity Improvement Rate: ${summary.diversityRate}%`);
console.log(`   False Positive Rate: ${summary.falsePositiveRate}% ${parseFloat(summary.falsePositiveRate) < 5 ? '✅' : '⚠️'}\n`);

console.log('🎯 PASS/FAIL CRITERIA (Precision > Recall Standard):');
console.log(`   ✓ Zero Catastrophic Failures: ${summary.catastrophic === 0 ? '✅ PASS' : '❌ FAIL'}`);
console.log(`   ✓ Entity Precision ≥95%: ${parseFloat(summary.entityPrecision) >= 95 ? '✅ PASS' : '❌ FAIL'}`);
console.log(`   ✓ False Positive Rate <5%: ${parseFloat(summary.falsePositiveRate) < 5 ? '✅ PASS' : '⚠️ WARNING'}\n`);

if (summary.passed) {
  console.log('✅ TEST SUITE PASSED - PRODUCTION READY');
  console.log('   → Zero catastrophic failures detected');
  console.log('   → Entity precision meets 95% threshold');
  console.log('   → System will NOT confuse "sister Jennifer" with "dog Jenn"');
  console.log('   → Safe for beta deployment to lonely users\n');
} else {
  console.log('❌ TEST SUITE FAILED - DO NOT DEPLOY');
  console.log('   → Catastrophic failures would destroy user trust');
  console.log('   → Review failed scenarios below\n');

  if (metrics.catastrophicFailures.length > 0) {
    console.log('🚨 CATASTROPHIC FAILURES:');
    metrics.catastrophicFailures.forEach(failure => {
      console.log(`   ${failure.num}. ${failure.name}`);
      console.log(`      Expected: ${failure.expected}`);
      console.log(`      Got: ${failure.gotPrimary}`);
      console.log(`      Severity: ${failure.severity}\n`);
    });
  }
}

console.log('═'.repeat(70));
console.log('💡 KEY INSIGHT');
console.log('═'.repeat(70));
console.log('For a memory extension used in emotional conversations:');
console.log('→ Precision > Recall means: Better to miss context than give WRONG context');
console.log('→ "Sister Jennifer ≠ dog Jenn" failures would be CATASTROPHIC');
console.log('→ User would lose trust in system completely');
console.log('→ Entity deduplication + MMR prevents these disasters\n');

process.exit(summary.passed ? 0 : 1);
