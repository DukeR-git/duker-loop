## Agent I/O Architecture

| Agent | Reads (Inputs) | Writes / Modifies (Outputs) |
| :--- | :--- | :--- |
| **Main Orchestrator** | `Full_Plan.md`, `Current_State.md` | Spawns subagents; modifies NO files directly. |
| **Precise Planner** | Orchestrator prompt, `CURRENT_REPORT.md` (if looping) | Creates `CURRENT_PLAN.md` or `FIXING_PLAN.md`. |
| **Implementer** | `CURRENT_PLAN.md` or `FIXING_PLAN.md` | Modifies **Codebase**; appends errors, other findings or fixes to `ISSUES.md`. |
| **Tester** | **Codebase**, `CURRENT_PLAN.md` | Appends errors to `ISSUES.md`. |
| **Reviewer** | **Codebase**, `CURRENT_PLAN.md`, `ISSUES.md` | Appends errors or improvable code to `ISSUES.md`. |
| **Reporter** | `ISSUES.md` | Thinks about `ISSUES.md`; writes `CURRENT_REPORT.md`. |
| **State Updater** | *Triggers on completion* `CURRENT_PLAN.md`, `CURRENT_REPORT.md`, **Codebase** | Appends milestones to `Current_State.md` if `CURRENT_REPORT.md` is clean. |
| **Cleaner** | *Triggers on completion* | Wipes all temp `.md` files (`CURRENT_PLAN`, etc.). |

---

## The Execution Lifecycle (With Feedback Loop)

*   **Step 1: Orchestration Initiation** 
    The Main Orchestrator reads `Full_Plan.md`, extracts the exact next step (e.g., "Build Auth API"), verifies dependencies in `Current_State.md`, and spins up the Precise Planner.
*   **Step 2: Tactical Planning** 
    The Precise Planner generates `CURRENT_PLAN.md`, detailing everything extensively, the database schema, required endpoints, and logic needed to implement the feature cleanly.
*   **Step 3: Initial Implementation** 
    The Implementer reads `CURRENT_PLAN.md`. It creates `src/api/auth.js` and modifies `src/db/schema.sql` in the **Codebase**.
*   **Step 4a: Validation & Failure** 
    The Tester runs the dynamic test suite. The Tester discovers a null pointer exception in `src/api/auth.js`. It writes the stack trace into `ISSUES.md`.  `CURRENT_REPORT.md`.
*   **Step 4b: Validation & Failure**
	The Reviewer analyzes the static code. It discovers function which could be written way faster or easier with the same results. It adds it to `ISSUES.md`.
*   **Step 5: Report**
	The Reporter reads `ISSUES.md`, and creates `CURRENT_REPORT.md` about what needs fixing.
*   **Step 6: The Corrective Loop** 
    The failure loops control back to the Precise Planner. It reads the report and generates a highly specific `FIXING_PLAN.md` to handle the reportings.
*   **Step 7: Re-Implementation** 
    The Implementer reads `FIXING_PLAN.md`, patches `src/api/auth.js`, and updates `ISSUES.md` to note the patch was applied.
*   **Step 8: Parallel Validation Success** 
    The Tester and Reviewer test and review the implementation of `CURRENT_PLAN.md` and `FIXING_PLAN.md`. The codebase passes.
*   **Step 9: Report**
	The Reporter reads `ISSUES.md`, sees that everything is fixed and writes PASS statement in `CURRENT_REPORT.md`.
	

*   **Step 10: State Persistence** 
    ON PASS: The State Updater reads the clean `CURRENT_REPORT.md`, confirms the new `auth.js` logic in the Codebase, and appends "Build Auth API - COMPLETE" to `Current_State.md`.
*   **Step 11: Workspace Teardown** 
    The Cleaner deletes `CURRENT_PLAN.md`, `FIXING_PLAN.md`, `ISSUES.md`, and `CURRENT_REPORT.md` to prevent context pollution.
*   **Step 12: Next Cycle Initiation** 
    ON PASS: Control returns to the Main Orchestrator. It reads `Full_Plan.md` and extracts the next step (e.g., "Build User Dashboard").