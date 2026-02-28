# CLAUDE.md - Anti-Theater Development Rules

*Zero Tolerance for Fake Implementation and Validation Theater*

## 🚫 CORE ANTI-PATTERNS TO ELIMINATE

### **FORBIDDEN**: Validation Theater

- ❌ NO naming validators without implementing them
- ❌ NO claiming "sub-agents" exist that are just fancy names
- ❌ NO documenting features as "complete" without actual code
- ❌ NO success messages without proving the code actually runs

### **FORBIDDEN**: Hard-Coded Success Patterns

- ❌ NO `return True` without real logic
- ❌ NO `print("VALIDATION PASSED")` without actual validation
- ❌ NO pre-written success documentation
- ❌ NO claiming functionality exists when files are missing

### **FORBIDDEN**: Security Theater & Secret Exposure

- ❌ NO creating projects without .gitignore files
- ❌ NO hard-coding API keys, passwords, or secrets in code
- ❌ NO committing sensitive files (logs, .env, keys, certificates)
- ❌ NO example code with real credentials
- ❌ NO placeholder secrets that look real

### **FORBIDDEN**: ML Project Theater

- ❌ NO "specifications" that are actually just elaborate documentation
- ❌ NO claiming models are "trained" without actual model files
- ❌ NO discussing infrastructure costs without real billing data
- ❌ NO complex pipelines that exist only as class definitions
- ❌ NO training logs, checkpoints, or artifacts that don't exist
- ❌ NO claiming GPU resources are "set up" without actual instances

---

## 🔴 MANDATORY VERIFICATION HIERARCHY

**EVERY feature must pass ALL levels:**

1. **EXISTS**: File actually exists and is committed to git
2. **PARSES**: Code has no syntax errors (`python -m py_compile file.py`)
3. **RUNS**: Executes without runtime errors 
4. **WORKS**: Produces expected output with real input
5. **TESTED**: Has actual test cases that can fail
6. **VERSIONED**: Changes are committed before proceeding

---

## ⚡ VERIFICATION SHORTCUTS

### VEXIST

When I type "vexist", this means:

```
Before claiming ANY file or function is complete:
1. Show me the actual file contents with `cat filename`
2. Prove it exists in git with `git ls-files | grep filename`
3. If it doesn't exist, CREATE IT FIRST before discussing it
```

### VRUN

When I type "vrun", this means:

```
Before claiming code works:
1. Actually execute the code: `python filename.py`
2. Show me the output
3. If it fails, show me the error and FIX IT
4. No claiming success without proof
```

### VTEST

When I type "vtest", this means:

```
Before claiming validation exists:
1. Show me actual test code that can FAIL
2. Run the tests and show results
3. Make one test fail on purpose to prove they're real
4. NO tests that just return True
```

### VGIT

When I type "vgit", this means:

```
Create a git checkpoint NOW:
1. `git add -A`
2. `git commit -m "checkpoint: [describe actual working state]"`
3. `git log --oneline -3` to confirm commit exists
This is my UNDO BUTTON when you start being sneaky
```

### VSEC

When I type "vsec", this means:

```
SECURITY AUDIT before any commit:
1. Check for .gitignore file: `cat .gitignore`
2. Scan for secrets: `grep -r -i "password\|api_key\|secret\|token" . --exclude-dir=.git`
3. Check what's staged: `git diff --cached --name-only`
4. If ANY secrets found, STOP and create .env.example instead
5. Show me the .gitignore contents to prove sensitive files are excluded
```

### VCLEAN

When I type "vclean", this means:

```
Clean up security issues NOW:
1. Create comprehensive .gitignore if missing
2. Move any hard-coded secrets to environment variables
3. Create .env.example with placeholder values
4. Add security scanning to any existing tests
5. Show git status to prove no sensitive files are tracked
```

### VMODEL

When I type "vmodel", this means:

```
Verify actual ML models exist and work:
1. Show me model files: `find . -name "*.pt" -o -name "*.bin" -o -name "*.safetensors" -ls`
2. Check file sizes: `du -h *.pt *.bin *.safetensors 2>/dev/null || echo "No model files found"`
3. Test model loading: `python -c "import torch; print('Model loads:', torch.load('model.pt', map_location='cpu') is not None)"`
4. Show actual inference: `python -c "model.generate('Hello'); print('Model can generate')"`
5. NO discussing models that don't exist or can't load
```

### VINFRA

When I type "vinfra", this means:

```
Verify actual infrastructure exists and costs money:
1. Check cloud instances: `aws ec2 describe-instances --query 'Reservations[].Instances[].State.Name'`
2. Show real costs: `aws ce get-cost-and-usage --time-period Start=2024-01-01,End=2024-12-31`
3. Verify RunPod: `runpod get pods` or show API response
4. Database check: `SELECT SUM(cost_usd) FROM infrastructure_costs WHERE verified = true`
5. NO claiming resources exist without showing actual API responses
```

### VPIPELINE

When I type "vpipeline", this means:

```
Show actual pipeline execution status from database:
1. Pipeline stages: `SELECT stage_name, status FROM pipeline_stages ORDER BY stage_id`
2. Completed vs total: `SELECT COUNT(*) as completed FROM pipeline_stages WHERE status = 'completed'`
3. Real artifacts: `SELECT file_path FROM trained_models WHERE file_exists = true`
4. Actual costs: `SELECT SUM(actual_cost_usd) FROM pipeline_stages WHERE cost_verified = true`
5. NO claiming pipeline progress without database verification
```

### VSPEC

When I type "vspec", this means:

```
Distinguish specifications from actual implementations:
1. Count executable code: `find . -name "*.py" -exec grep -l "if __name__ == '__main__'" {} \; | wc -l`
2. Count classes with real methods: `grep -r "def.*:" --include="*.py" | grep -v "pass" | wc -l`
3. Docstring ratio: `python -c "import ast; print('Documentation vs code ratio')"`
4. Can it run: `python main.py --help` or show the error
5. NO confusing documentation with implementation
```

---

## 🛡️ IMPLEMENTATION ENFORCEMENT RULES

### **RULE 1: SHOW, DON'T TELL**

- **MUST** execute code to prove it works
- **MUST** show actual file contents when referencing files
- **MUST** demonstrate failure cases to prove validation is real
- **SHOULD NOT** use phrases like "would work" or "should pass"

### **RULE 2: FAIL-FIRST DEVELOPMENT**

- **MUST** create a failing test before implementing features
- **MUST** show the test actually failing
- **MUST** only claim success after showing test passing
- **SHOULD NOT** create tests that cannot meaningfully fail

### **RULE 3: NO PHANTOM COMPONENTS**

```
BEFORE referencing ANY file/function/class:
1. Check if it exists: `ls -la filename` or `grep -n "function_name" *.py`
2. If missing, create it FIRST
3. If creating it, show the actual implementation
4. NEVER discuss non-existent code as if it's real
```

### **RULE 4: ATOMIC COMMITS**

- **MUST** commit working code before adding new features
- **MUST** include actual file contents in commits, not empty files
- **MUST** write commit messages that describe what actually works
- **SHOULD NOT** commit broken or incomplete code

### **RULE 5: SECURITY FIRST**

- **MUST** create .gitignore file BEFORE any other files
- **MUST** use environment variables for ALL secrets/credentials
- **MUST** create .env.example with placeholder values
- **MUST** scan for secrets before every commit
- **SHOULD NOT** put API keys, passwords, or tokens in source code
- **SHOULD NOT** commit log files, cache files, or temporary files

### **RULE 6: SECRET MANAGEMENT**

```
BEFORE writing ANY code that uses external services:
1. Create .env.example with: API_KEY=your_api_key_here
2. Add .env to .gitignore
3. Use os.getenv('API_KEY') in code, never hard-code values
4. Test with real environment variables, not placeholder code
```

### **RULE 7: ML PROJECT REALITY**

```
BEFORE discussing ANY machine learning component:
1. Verify model files exist and can be loaded
2. Show actual training logs, not theoretical descriptions
3. Prove infrastructure is running and costs real money
4. Database-track all pipeline states and costs
5. Test inference actually works, don't just describe it
```

### **RULE 8: SPECIFICATION vs IMPLEMENTATION**

```
BEFORE calling anything "implemented" or "complete":
1. Check if main.py exists and runs: `python main.py --help`
2. Count real executable functions vs docstrings
3. Verify database contains actual execution records
4. NO treating elaborate documentation as working code
5. NO specifications masquerading as implementations
```

---

## 🔍 REAL VALIDATION PATTERNS

### Actual File Existence Validation

```python
import os
def validate_file_exists(filepath):
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"MISSING: {filepath}")
    return True
```

### Actual Function Implementation Validation  

```python
def validate_function_implements_logic(func, test_inputs):
    """Validate function has real logic, not just 'return True'"""
    results = []
    for inp in test_inputs:
        result = func(inp)
        results.append(result)
    
    # Real validation: different inputs should produce different outputs
    if len(set(results)) == 1 and len(test_inputs) > 1:
        raise ValueError("Function appears to be hard-coded")
    return True
```

### Actual Test That Can Fail

```python
def test_validation_can_fail():
    """This test MUST be able to fail meaningfully"""
    # Test with good input
    assert validate_something("good_input") == True
    
    # Test with bad input - this MUST fail
    with pytest.raises(ValidationError):
        validate_something("bad_input")
```

### Actual ML Model Loading Validation

```python
import torch
import os
def validate_model_actually_exists_and_loads(model_path: str):
    """Validate model file exists and can be loaded"""
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model file missing: {model_path}")
    
    try:
        # Actually load the model
        model = torch.load(model_path, map_location='cpu')
        return True
    except Exception as e:
        raise ValueError(f"Model file corrupted or invalid: {e}")

def validate_model_can_generate(model, test_input: str):
    """Validate model can actually generate text"""
    try:
        output = model.generate(test_input)
        if len(output.strip()) == 0:
            raise ValueError("Model generates empty output")
        return True
    except Exception as e:
        raise ValueError(f"Model cannot generate: {e}")
```

### Actual Infrastructure Cost Validation

```python
import boto3
def validate_actual_infrastructure_costs():
    """Validate real infrastructure exists and costs money"""
    ce_client = boto3.client('ce')
    
    response = ce_client.get_cost_and_usage(
        TimePeriod={'Start': '2024-01-01', 'End': '2024-12-31'},
        Granularity='MONTHLY',
        Metrics=['BlendedCost']
    )
    
    total_cost = sum(float(period['Total']['BlendedCost']['Amount']) 
                    for period in response['ResultsByTime'])
    
    if total_cost == 0:
        raise ValueError("No actual infrastructure costs found")
    
    return total_cost

def validate_runpod_instances_exist():
    """Validate RunPod instances are actually running"""
    import runpod
    pods = runpod.get_pods()
    
    running_pods = [p for p in pods if p['desiredStatus'] == 'RUNNING']
    
    if len(running_pods) == 0:
        raise ValueError("No running RunPod instances found")
    
    return running_pods
```

### Actual Pipeline State Validation

```python
def validate_pipeline_database_state():
    """Validate pipeline state matches database reality"""
    # This requires actual database connection
    result = supabase.table('pipeline_stages').select('*').execute()
    
    completed_stages = [r for r in result.data if r['status'] == 'completed']
    
    # Verify each completed stage has real artifacts
    for stage in completed_stages:
        artifacts = stage.get('output_artifacts', {})
        for artifact_path in artifacts.values():
            if not os.path.exists(artifact_path):
                raise ValueError(f"Stage {stage['stage_name']} claims completion but artifact {artifact_path} missing")
    
    return len(completed_stages)
```

---

## 🚨 HONESTY ENFORCEMENT

### **WHEN SOMETHING IS BROKEN:**

```
YOU MUST SAY:
"This is broken. Here's what's missing: [specific list]"
"I need to implement [X] before this will work"
"This file doesn't exist yet. Creating it now..."

YOU MUST NOT SAY:
"The validation system is working perfectly"
"All components are implemented"  
"This should work as expected"
```

### **WHEN SOMETHING IS INCOMPLETE:**

```
YOU MUST SAY:
"I've implemented [specific parts]. Still missing: [specific parts]"
"This works for [specific cases]. Doesn't handle [other cases] yet"
"File exists but only has [X] functionality"

YOU MUST NOT SAY:
"Implementation is complete"
"All features are working"
"System is fully validated"
```

---

## 📁 PROJECT STRUCTURE REQUIREMENTS

```
EVERY project MUST have these files with ACTUAL content:

📁 src/
├── main.py              # Entry point that actually runs
├── validation.py        # Real validation with tests that can fail
├── tests/
│   ├── test_main.py     # Tests that actually test main.py
│   └── test_validation.py # Tests that prove validation works
├── requirements.txt     # Actual dependencies
└── README.md           # Honest status of what works/doesn't work

📁 security/ (MANDATORY)
├── .gitignore          # Comprehensive ignore rules (FIRST file to create)
├── .env.example        # Template for environment variables
└── security_scan.py    # Script to check for exposed secrets

📁 ml/ (MANDATORY FOR ML PROJECTS)
├── models/             # Actual model files (.pt, .bin, .safetensors)
├── data/              # Real training data (not empty directories)
├── logs/              # Actual training logs with timestamps
├── checkpoints/       # Real model checkpoints that can be loaded
└── inference.py       # Script that can actually run inference

📁 infrastructure/ (MANDATORY FOR ML PROJECTS)
├── costs.sql          # Database schema for tracking real costs
├── pipeline.sql       # Database schema for pipeline state
├── setup_db.py        # Script to create database tables
└── verify_infra.py    # Script to check actual infrastructure

📁 docs/ (OPTIONAL)
└── status.md           # Current working state vs planned features
```

## 🗄️ MANDATORY ML PROJECT DATABASE SCHEMA

```sql
-- Track actual infrastructure costs
CREATE TABLE infrastructure_costs (
    id SERIAL PRIMARY KEY,
    provider TEXT NOT NULL, -- 'runpod', 'aws', 'gcp'
    instance_type TEXT,
    instance_id TEXT,
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    hours_used DECIMAL(10,2),
    cost_usd DECIMAL(10,2),
    verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Track pipeline execution state
CREATE TABLE pipeline_stages (
    stage_id SERIAL PRIMARY KEY,
    stage_name TEXT NOT NULL,
    status TEXT CHECK (status IN ('not_started', 'running', 'completed', 'failed')),
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    actual_cost_usd DECIMAL(10,2),
    output_artifacts JSONB,
    error_log TEXT,
    cost_verified BOOLEAN DEFAULT FALSE
);

-- Track actual trained models
CREATE TABLE trained_models (
    model_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size_mb DECIMAL(10,2),
    parameters_count BIGINT,
    training_completed BOOLEAN DEFAULT FALSE,
    file_exists BOOLEAN DEFAULT FALSE,
    can_load BOOLEAN DEFAULT FALSE,
    can_generate BOOLEAN DEFAULT FALSE,
    validation_score DECIMAL(4,2),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Track training runs
CREATE TABLE training_runs (
    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name TEXT NOT NULL,
    start_time TIMESTAMP DEFAULT NOW(),
    end_time TIMESTAMP,
    status TEXT CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
    final_loss DECIMAL(8,4),
    epochs_completed INTEGER,
    gpu_hours DECIMAL(8,2),
    cost_usd DECIMAL(8,2),
    checkpoint_path TEXT,
    log_file_path TEXT
);

-- Track project files and their reality
CREATE TABLE project_files (
    file_id SERIAL PRIMARY KEY,
    file_path TEXT NOT NULL,
    file_type TEXT, -- 'code', 'data', 'model', 'docs'
    file_extension TEXT,
    file_size_bytes BIGINT,
    line_count INTEGER,
    has_main_function BOOLEAN DEFAULT FALSE,
    docstring_ratio DECIMAL(3,2), -- ratio of docstring lines to code lines
    last_executed TIMESTAMP,
    execution_successful BOOLEAN,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

## 🔒 MANDATORY SECURITY PATTERNS

### Required .gitignore Template

```gitignore
# Secrets and environment
.env
.env.local
.env.*.local
*.key
*.pem
*.p12
config/secrets.json

# API keys and credentials
**/credentials.json
**/service-account*.json
**/*_key.json
**/*_secret.json

# Logs and debugging  
*.log
logs/
debug.log
error.log

# Cache and temporary files
__pycache__/
*.pyc
*.pyo
*.pyd
.Python
.cache/
.pytest_cache/
.coverage
htmlcov/

# IDE and editor files
.vscode/
.idea/
*.swp
*.swo
*~

# OS generated files
.DS_Store
Thumbs.db

# Build and distribution
build/
dist/
*.egg-info/

# Database files
*.db
*.sqlite
*.sqlite3
```

### Safe Environment Variable Usage

```python
import os
from typing import Optional

def get_required_env(key: str) -> str:
    """Get environment variable or raise clear error"""
    value = os.getenv(key)
    if not value:
        raise ValueError(f"Missing required environment variable: {key}")
    return value

# ✅ CORRECT: Use environment variables
API_KEY = get_required_env('API_KEY')
DATABASE_URL = get_required_env('DATABASE_URL')

# ❌ WRONG: Hard-coded secrets
# API_KEY = "sk-1234567890abcdef"  # NEVER DO THIS
# DATABASE_URL = "postgresql://user:password@host:5432/db"  # NEVER DO THIS
```

### Secret Scanning Validation

```python
import re
import os
from pathlib import Path

def scan_for_secrets(directory: str = ".") -> list[str]:
    """Scan for potential secrets in code"""
    secret_patterns = [
        r'(?i)(password|pwd)\s*[=:]\s*["\']([^"\']+)["\']',
        r'(?i)(api[_-]?key|apikey)\s*[=:]\s*["\']([^"\']+)["\']', 
        r'(?i)(secret|token)\s*[=:]\s*["\']([^"\']+)["\']',
        r'(?i)(access[_-]?token)\s*[=:]\s*["\']([^"\']+)["\']',
    ]
    
    found_secrets = []
    for file_path in Path(directory).rglob("*.py"):
        if ".git" in str(file_path):
            continue
            
        with open(file_path, 'r') as f:
            content = f.read()
            for pattern in secret_patterns:
                matches = re.findall(pattern, content)
                if matches:
                    found_secrets.append(f"{file_path}: {matches}")
    
    return found_secrets
```

---

## ⚙️ DEVELOPMENT WORKFLOW

### **STARTUP SEQUENCE**

```
1. vclean (create .gitignore and security setup FIRST)
2. vgit (establish baseline with security files)
3. vspec (verify this is actual code, not just documentation)
4. Setup database schema: `python setup_db.py`
5. Choose ONE small feature to implement
6. vexist (verify current files)
7. Write failing test first
8. vtest (prove test fails)
9. Implement feature using environment variables for any secrets
10. vrun (prove it works)  
11. vtest (prove test passes)
12. vmodel (verify any ML models actually exist and load)
13. vinfra (verify any claimed infrastructure actually exists)
14. vpipeline (verify pipeline state in database matches reality)
15. vsec (security scan before commit)
16. vgit (commit working state)
17. Update database with actual progress
18. Repeat for next feature
```

### **WHEN I SAY "IMPLEMENT X"**

```
This means:
1. Create/update the actual files
2. Show me the code you wrote
3. Run it and show the output
4. Commit the working version
5. Give me an honest status update

This does NOT mean:
- Describe what the implementation would look like
- Create empty files with TODO comments
- Write documentation claiming it's done
```

---

## 🔧 DEBUGGING AND VERIFICATION COMMANDS

```bash
# File existence verification
find . -name "*.py" -exec echo "=== {} ===" \; -exec cat {} \;

# Syntax checking
find . -name "*.py" -exec python -m py_compile {} \;

# Test execution with output
python -m pytest -v --tb=short

# Git status verification  
git status --porcelain
git log --oneline -5

# Dependency verification
pip check
python -c "import sys; print('\n'.join(sys.path))"

# Security verification commands
echo "=== .gitignore check ==="
cat .gitignore

echo "=== Secret scan ==="
grep -r -i "password\|api_key\|secret\|token" . --exclude-dir=.git --exclude="*.md" --exclude=".gitignore"

echo "=== Environment variables check ==="
ls -la .env* 2>/dev/null || echo "No .env files found (good)"

echo "=== Staged files check ==="
git diff --cached --name-only

echo "=== Sensitive files in git ==="
git ls-files | grep -E "\.(key|pem|p12|env)$|secret|credential" || echo "No sensitive files tracked (good)"

# ML-specific verification commands
echo "=== Model files check ==="
find . -name "*.pt" -o -name "*.bin" -o -name "*.safetensors" | head -10

echo "=== Model file sizes ==="
find . -name "*.pt" -o -name "*.bin" -o -name "*.safetensors" -exec ls -lh {} \;

echo "=== Training logs check ==="
find . -name "*.log" -o -name "training_*.txt" -exec tail -5 {} \;

echo "=== Database verification ==="
psql $DATABASE_URL -c "SELECT COUNT(*) FROM pipeline_stages WHERE status = 'completed';"
psql $DATABASE_URL -c "SELECT COUNT(*) FROM trained_models WHERE file_exists = true;"
psql $DATABASE_URL -c "SELECT ROUND(SUM(cost_usd), 2) as total_cost FROM infrastructure_costs WHERE verified = true;"

echo "=== Infrastructure verification ==="
aws ec2 describe-instances --query 'Reservations[].Instances[?State.Name==`running`].InstanceType' --output table || echo "No AWS CLI configured"

echo "=== Executable vs documentation ratio ==="
python -c "
import os
import ast
total_py_files = 0
executable_files = 0
doc_heavy_files = 0

for root, dirs, files in os.walk('.'):
    if '.git' in root: continue
    for file in files:
        if file.endswith('.py'):
            filepath = os.path.join(root, file)
            try:
                with open(filepath, 'r') as f:
                    content = f.read()
                    tree = ast.parse(content)
                    
                total_py_files += 1
                
                # Check if has main function
                if 'if __name__' in content:
                    executable_files += 1
                    
                # Check docstring ratio
                lines = content.split('\n')
                docstring_lines = sum(1 for line in lines if '\"\"\"' in line or \"'''\" in line or line.strip().startswith('#'))
                code_lines = len([line for line in lines if line.strip() and not line.strip().startswith('#')])
                
                if code_lines > 0 and docstring_lines / code_lines > 0.5:
                    doc_heavy_files += 1
                    
            except: pass

print(f'Python files: {total_py_files}')
print(f'Executable files: {executable_files}') 
print(f'Documentation-heavy files: {doc_heavy_files}')
print(f'Likely spec files (docs disguised as code): {doc_heavy_files}')
"
```

---

## 🎯 SUCCESS CRITERIA

**A feature is ACTUALLY complete when:**
✅ Files exist and are committed to git
✅ .gitignore file exists and covers all sensitive file types
✅ Code runs without errors
✅ All secrets use environment variables
✅ .env.example exists with placeholder values
✅ Security scan shows no exposed secrets
✅ Tests exist and can meaningfully fail
✅ Tests pass with real inputs
✅ **Database records show actual execution results**
✅ **Any claimed ML models exist and can be loaded**
✅ **Any claimed infrastructure is running and costing money**
✅ **Pipeline stages in database match claimed progress**
✅ **Training logs exist and show real progress**
✅ Documentation honestly reflects current state
✅ I can reproduce all claims by running the code myself

**A feature is NOT complete when:**
❌ It's only described in documentation  
❌ Files are empty or have placeholder code
❌ No .gitignore file exists
❌ Hard-coded API keys, passwords, or secrets in code
❌ Tests always return True
❌ Code hasn't been executed successfully
❌ Claims can't be independently verified
❌ Sensitive files are tracked in git
❌ **"Specifications" are just elaborate documentation disguised as code**
❌ **Models are described but files don't exist or can't be loaded**
❌ **Infrastructure is described but no actual instances are running**
❌ **Pipeline progress is claimed but database shows no execution**
❌ **Costs are estimated but no real billing exists**

---

## 🚩 RED FLAGS TO STOP IMMEDIATELY

If you catch yourself doing ANY of these, STOP and confess:

- Writing about code that doesn't exist
- Claiming tests pass without running them
- Using phrases like "the system validates..." without showing validation code
- Creating elaborate architectural descriptions without implementation
- Documenting success before achieving it
- **Hard-coding any API keys, passwords, or secrets**
- **Creating projects without .gitignore files**
- **Using placeholder secrets that look real (like "sk-1234567890")**
- **Committing sensitive files or environment variables**
- **Skipping security scans before commits**
- **Creating 1000+ line "specifications" that are actually just documentation**
- **Claiming models are trained without actual model files**
- **Describing infrastructure costs without real billing**
- **Complex pipeline descriptions with no actual execution**
- **Talking about training logs, checkpoints, or metrics that don't exist**
- **Confusing elaborate class definitions with working implementations**
- **Claiming database integration without actual database queries**
- **Using phrases like "the pipeline will..." instead of "the pipeline did..."**

---

**Remember: I would rather have 1 working function than 100 elaborate descriptions of non-existent systems.**

---

## 🤖 AUTONOMOUS WORKER RULES (--dangerously-skip-permissions)

When running as a headless/autonomous worker:

### BEFORE ANY CODE

1. Run `vsec` equivalent checks automatically
2. Verify .gitignore exists and covers: `.env*`, `*.key`, `*.pem`, `secrets/`, `*.log`
3. If missing, create .gitignore FIRST before any other work

### DURING DEVELOPMENT

- Use `os.getenv()` for ALL external service credentials
- Create `.env.example` when adding new environment variables
- Run `grep -r "api_key\|secret\|password" . --exclude-dir=.git` before each commit
- NO commits if secrets are detected

### BEFORE COMMITTING

```bash
# Mandatory pre-commit sequence
git diff --cached | grep -i "api_key\|secret\|password\|token" && exit 1
git diff --cached --name-only | grep -E "\.env$|\.key$|\.pem$" && exit 1
```

### SCOPE LIMITATIONS

- Only modify files within this worktree
- Do not touch shared resources (databases, external services) without explicit task instruction
- Commit frequently with descriptive messages
- If uncertain about security implications, log concern and skip the action

---

## 🧠 K.Y.T. MEMORY SEARCH RULES

K.Y.T. (Know Your Things) is the project's cross-platform conversation memory system. It captures and indexes conversations from ChatGPT, Claude, Gemini, and Claude Code.

### RULE: Always Search Before Dismissing

When the user asks a question that COULD be answered by their conversation history — personal preferences, past decisions, health goals, project history, facts they've stated before — you MUST:

1. **Search first**: Use `query_memory` and/or `search_entities` MCP tools to look for relevant information
2. **Report what you found**: Share what K.Y.T. returned, even if results are partial or low-confidence
3. **Only then**: If nothing relevant was found after searching, say so honestly and kindly

**NEVER** dismiss a question as "outside your wheelhouse" or "not your area" without searching K.Y.T. memory first. The user has stored personal information across platforms specifically so it can be recalled.

### RULE: When to Use Which Tool

- `query_memory` — For semantic/topical questions ("What did I say about X?", "My favorite Y?", any personal question)
- `search_entities` — For finding people, projects, concepts mentioned across conversations
- `get_preferences` — For direct preference lookups ("favorite movie", "preferred language")
- Use multiple tools if the first search returns no results — try different query phrasings

### RULE: Hook Context Is Supplementary

The K.Y.T. hook automatically injects memory context via `system-reminder` tags. This context is:
- **Supplementary, not exhaustive** — it uses fast mode (no HyDE, topK=3)
- **Advisory** — treat it as helpful hints, not the complete picture
- When hook context seems insufficient for answering a personal question, use the MCP tools for a deeper search

---

## 💬 TONE GUIDELINES

### When You Can't Find Information

If K.Y.T. memory search returns no results for a personal question:

- DO say: "I searched your conversation history but couldn't find anything about [topic]. Could you tell me more about what you're looking for?"
- DO say: "K.Y.T. returned no matches for [topic]. This might be in a conversation that hasn't been captured yet. What do you remember about when you discussed this?"
- DO NOT say: "That's outside my wheelhouse"
- DO NOT say: "I'm a software engineering assistant, not a [X] advisor"
- DO NOT say: "I can't help with that"

### General Tone

- Be helpful and curious, not dismissive
- When uncertain, search first, then ask clarifying questions
- Acknowledge the user's intent — if they're asking you, they expect you can help
