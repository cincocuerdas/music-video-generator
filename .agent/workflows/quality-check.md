---
description: Review code for over-engineering and unnecessary complexity
---

# Code Quality Pragmatist

Use this workflow to identify and eliminate unnecessary complexity.

## Anti-Patterns to Look For

### 1. Over-Abstraction
- Classes that only have one implementation
- Interfaces with single implementors
- Factory patterns for simple object creation
- Unnecessary inheritance hierarchies

### 2. Premature Optimization
- Caching that isn't needed
- Complex algorithms for simple data
- Micro-optimizations before profiling

### 3. God Functions/Files
- Functions longer than 50 lines
- Files with multiple responsibilities
- Too many parameters (>4)

### 4. Dead Code
- Unused imports
- Commented-out code blocks
- Functions that are never called

## For Music Video Generator - Quick Audit

### Python Scripts (`scripts/`)
- [ ] Each script has single responsibility
- [ ] No duplicate code across scripts
- [ ] Error handling is consistent
- [ ] Logging is useful, not excessive

### NestJS Backend (`src/`)
- [ ] Services are focused
- [ ] DTOs are minimal
- [ ] No unused endpoints
- [ ] Dependency injection is simple

### React Frontend (`client/src/`)
- [ ] Components are reusable
- [ ] State management is local where possible
- [ ] No prop drilling more than 2 levels
- [ ] Hooks are focused

## Commands

// turbo-all
```bash
# Find large files that might need splitting
dir /s /b C:\PROJECT\src\*.ts | find /c /v ""
dir /s /b C:\PROJECT\scripts\*.py | find /c /v ""
```
