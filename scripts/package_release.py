"""Build the subscriber ZIP from npm's runtime file list. Run from the package directory."""
import argparse
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text())["version"]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--out", type=Path, default=root / "dist")
out = parser.parse_args().out.resolve()
out.mkdir(parents=True, exist_ok=True)
target = out / f"coordinator-board-{version}.zip"
required = {
    "paseo-plugin.json", "index.client.tsx", "index.server.ts", "shared/contract.ts",
    "server/preferences.ts", "server/conversation.ts", "server/coordinator.ts",
    "server/notes.ts", "server/discovery.ts", "server/reporting.ts", "client/board.tsx",
    "shared/dispatch.ts", "shared/operations.ts", "server/dispatch.ts", "server/operations.ts", "server/lifecycle.ts",
    "server/digest.ts", "client/coordinator-pin.tsx", "client/operations.tsx", "client/photo-composer.tsx", "client/work-photos.ts", "client/route-editor.tsx", "client/providers.tsx",
    "client/hosts.tsx", "shared/hosts.ts", "client/route-options.ts",
    "client/dispatch-hosts.tsx", "shared/dispatch-hosts.ts", "shared/host-assignment.ts",
    "server/board-sessions.ts", "server/host-assignment.ts", "server/session-decisions.ts", "server/worker-assignment.ts",
    "server/decisions.ts", "shared/decision-actions.ts", "client/decision-actions.tsx", "client/decision-reply.tsx", "client/decision-reply-state.ts",
    "client/session-photos.tsx", "server/session-photos.ts", "shared/session-photos.ts",
    "server/board-facts.ts", "shared/board-facts.ts", "client/fact-reply-controls.tsx",
    "server/recommendation.ts", "shared/recommendation.ts", "client/decision-summary.ts",
    "server/session-links.ts", "shared/session-links.ts", "client/session-links.tsx", "client/language.tsx",
    "shared/decision-priority.ts", "client/decision-priority.ts", "client/decision-editing.tsx", "client/decision-edit-order.ts",
    "shared/busy-delivery.ts", "client/queued-answer.tsx",
    "client/decision-receipts.ts", "client/inline-receipt.tsx", "client/merge-notification.ts",
    "client/pull-requests.tsx", "client/decision-badge.tsx", "shared/decision-count.ts", "shared/prs.ts", "server/prs.ts",
    "shared/tracked-decisions.ts", "server/tracked-decisions.ts", "server/project-decision-sources.ts", "server/pr-merge.ts", "server/merge-notifications.ts",
    "client/tracked-decisions.tsx", "client/project-kanban.tsx", "client/remote-running.tsx", "client/remote-sessions.ts",
    "shared/github-repository.ts", "shared/workspace-pull.ts", "shared/pages.ts", "server/snapshot-reads.ts", "shared/readiness.ts",
    "client/history-markdown.tsx", "client/vendor/marked/marked.js", "third-party/marked/LICENSE", "client/reply-history.tsx", "client/history-sessions.ts", "shared/reply-history.ts",
    "package.json", "LICENSE", "OVERVIEW.md", "README.md", "templates/coordinator-session.md",
    "third-party/better-paseo/LICENSE", "THIRD_PARTY_NOTICES.md", "assets/preview.png",
}
with tempfile.TemporaryDirectory() as scratch:
    result = subprocess.run(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
                            cwd=root, check=True, capture_output=True, text=True)
    packed = json.loads(result.stdout)[0]
    files = {entry["path"] for entry in packed["files"]}
    if not required <= files:
        raise RuntimeError(f"Missing files: {required - files}")
    with tarfile.open(Path(scratch) / packed["filename"], "r:gz") as archive:
        with tempfile.NamedTemporaryFile(dir=out, delete=False, suffix=".zip") as staged:
            staging_path = Path(staged.name)
        try:
            with zipfile.ZipFile(staging_path, "w") as package:
                for name in sorted(files):
                    path = PurePosixPath(name)
                    if path.is_absolute() or ".." in path.parts:
                        raise ValueError(name)
                    member = archive.getmember("package/" + name)
                    if not member.isfile():
                        raise ValueError(name)
                    info = zipfile.ZipInfo("coordinator-board/" + name)
                    info.create_system = 3
                    info.external_attr = 0o100644 << 16
                    package.writestr(info, archive.extractfile(member).read(), zipfile.ZIP_DEFLATED)
            staging_path.chmod(0o644)
            staging_path.replace(target)
        finally:
            staging_path.unlink(missing_ok=True)
print(target)
