import assert from "node:assert/strict";
import { test } from "node:test";
import { bashWriteTargets, checkBash, checkWrite, globToRegExp, readGuardConfig, relativeInside } from "../../child/guard.ts";

const cfg = { agent: "t", cwd: "/proj", allow: ["ISSUES.md", "tests/**", "**/*.test.*"], deny: ["Full_Plan.md", ".duker/**", ".git/**"] };
const open = { agent: "i", cwd: "/proj", allow: [], deny: ["Full_Plan.md", "Current_State.md"] };

test("globToRegExp", () => {
	assert.ok(globToRegExp("tests/**").test("tests/a/b.py"));
	assert.ok(globToRegExp("**/*.test.*").test("src/deep/foo.test.ts"));
	assert.ok(globToRegExp("**/*.test.*").test("foo.test.ts"));
	assert.ok(!globToRegExp("tests/*").test("tests/a/b.py"));
	assert.ok(globToRegExp("a?c").test("abc"));
	assert.ok(!globToRegExp("ISSUES.md").test("ISSUESXmd"));
});

test("relativeInside", () => {
	assert.equal(relativeInside("/proj", "ISSUES.md"), "ISSUES.md");
	assert.equal(relativeInside("/proj", "./src/a.py"), "src/a.py");
	assert.equal(relativeInside("/proj", "/proj/src/a.py"), "src/a.py");
	assert.equal(relativeInside("/proj", "@src/a.py"), "src/a.py");
	assert.equal(relativeInside("/proj", "../x"), null);
	assert.equal(relativeInside("/proj", "/etc/passwd"), null);
	assert.equal(relativeInside("/proj", "."), ".");
});

test("checkWrite: allow/deny/outside", () => {
	assert.ok(checkWrite(cfg, "ISSUES.md").ok);
	assert.ok(checkWrite(cfg, "tests/x.py").ok);
	assert.ok(checkWrite(cfg, "src/deep/foo.test.ts").ok);
	assert.ok(!checkWrite(cfg, "src/app.py").ok);
	assert.ok(!checkWrite(cfg, "Full_Plan.md").ok);
	assert.ok(!checkWrite(cfg, ".duker/state.json").ok);
	assert.ok(!checkWrite(cfg, "../other/ISSUES.md").ok);
	assert.ok(!checkWrite(cfg, "/etc/passwd").ok);
	assert.ok(checkWrite(open, "src/app.py").ok, "empty allow = anything not denied");
	assert.ok(!checkWrite(open, "Current_State.md").ok);
});

test("checkBash: git and rm policy", () => {
	for (const ok of ["git diff HEAD~1 -- src", "git status && git log --oneline -5", "git show abc", "rm -r build", "rm build/a.o", "python -m pytest -q", "grep -rn foo ."]) {
		assert.ok(checkBash(ok).ok, ok);
	}
	for (const bad of ["git add -A && git commit -m x", "git -C /proj commit -m x", "git push origin main", "git checkout -- .", "git rm -f Current_State.md", "git restore --staged x", "git add .", "git mv a b", "rm -rf build", "rm -fr build", "rm -r -f build", "rm --recursive --force build", "rm -Rf build", "rm build -rf", "cd x && rm -rf ."]) {
		assert.ok(!checkBash(bad).ok, bad);
	}
});

test("bashWriteTargets", () => {
	assert.deepEqual(bashWriteTargets("cat > FIXING_PLAN.md << 'EOF'"), ["FIXING_PLAN.md"]);
	assert.deepEqual(bashWriteTargets("echo hi >> ISSUES.md; ls 2>/dev/null"), ["ISSUES.md"]);
	assert.deepEqual(bashWriteTargets("pytest -q 2>&1 | tee -a out.log"), ["out.log"]);
	assert.deepEqual(bashWriteTargets("cmd &> \"logs/x.txt\""), ["logs/x.txt"]);
	assert.deepEqual(bashWriteTargets("python3 -m unittest -v"), []);
	assert.deepEqual(bashWriteTargets("if [ a -gt b ]; then echo x; fi"), []);
});

test("checkBash: redirection honours the write policy", () => {
	assert.ok(checkBash("echo x >> ISSUES.md", cfg).ok);
	assert.ok(!checkBash("cat > src/app.py << EOF", cfg).ok);
	assert.ok(!checkBash("pytest | tee Full_Plan.md", open).ok);
	assert.ok(checkBash("pytest | tee run.log", open).ok);
	assert.ok(!checkBash("echo x > /etc/motd", open).ok);
	assert.ok(checkBash("cat > src/app.py << EOF").ok, "no cfg → no path policy");
});

test("readGuardConfig parses env", () => {
	const c = readGuardConfig({ DUKER_AGENT: "tester", DUKER_CWD: "/p", DUKER_WRITE_ALLOW: '["ISSUES.md"]', DUKER_WRITE_DENY: "not json" });
	assert.deepEqual(c, { agent: "tester", cwd: "/p", allow: ["ISSUES.md"], deny: [] });
});
