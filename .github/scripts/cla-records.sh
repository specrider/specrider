#!/usr/bin/env bash
set -euo pipefail

CLA_VERSION="${CLA_VERSION:-individual-v1}"
CLA_RECORDS_DIR="${CLA_RECORDS_DIR:-.cla-records}"
CLA_SIGNATURES_PATH="${CLA_SIGNATURES_PATH:-signatures/${CLA_VERSION}.json}"
CLA_RECORDS_BRANCH="${CLA_RECORDS_BRANCH:-main}"
CLA_DOC_PATH="${CLA_DOC_PATH:-CLA.md}"
CLA_STATUS_CONTEXT="${CLA_STATUS_CONTEXT:-license/cla}"
CLA_SIGN_COMMENT="${CLA_SIGN_COMMENT:-I have read and agree to the SpecRider Individual Contributor License Agreement v1.}"
CLA_BYPASS_BOTS="${CLA_BYPASS_BOTS:-true}"
CLA_BYPASS_USERS="${CLA_BYPASS_USERS:-}"
CLA_BOT_NAME="${CLA_BOT_NAME:-specrider-cla-bot}"
CLA_BOT_EMAIL="${CLA_BOT_EMAIL:-cla@specrider.ai}"
CLA_PR_COMMENT="${CLA_PR_COMMENT:-true}"
# Login that authors the CLA status comment. Comments posted with the workflow's
# github.token are authored by github-actions[bot]; scoping comment lookups to
# this login prevents a PR author from spoofing the status marker to redirect
# the bot's edits.
CLA_COMMENT_AUTHOR="${CLA_COMMENT_AUTHOR:-github-actions[bot]}"

signature_file() {
  printf "%s/%s" "$CLA_RECORDS_DIR" "$CLA_SIGNATURES_PATH"
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "::error::Missing required environment variable: ${name}" >&2
    exit 1
  fi
}

lower() {
  printf "%s" "$1" | tr "[:upper:]" "[:lower:]"
}

join_mentions() {
  local sep=""
  local login
  for login in "$@"; do
    printf "%s@%s" "$sep" "$login"
    sep=", "
  done
}

ensure_tools() {
  local tool
  for tool in gh jq git sha256sum; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "::error::Required tool is not available on PATH: ${tool}" >&2
      exit 1
    fi
  done
}

is_bypassed() {
  local login="$1"
  local login_lc
  login_lc="$(lower "$login")"

  if [ "$CLA_BYPASS_BOTS" = "true" ] && [[ "$login_lc" == *"[bot]" ]]; then
    return 0
  fi

  local old_ifs="$IFS"
  local bypass
  IFS=","
  for bypass in $CLA_BYPASS_USERS; do
    IFS="$old_ifs"
    bypass="${bypass#"${bypass%%[![:space:]]*}"}"
    bypass="${bypass%"${bypass##*[![:space:]]}"}"
    if [ -n "$bypass" ] && [ "$login_lc" = "$(lower "$bypass")" ]; then
      return 0
    fi
    IFS=","
  done
  IFS="$old_ifs"

  return 1
}

has_signature() {
  local login_lc
  login_lc="$(lower "$1")"

  if [ ! -f "$(signature_file)" ]; then
    return 1
  fi

  jq -e \
    --arg login "$login_lc" \
    --arg version "$CLA_VERSION" \
    'type == "array" and any(.[]; (((.github_login // "") | ascii_downcase) == $login) and ((.cla_version // "") == $version))' \
    "$(signature_file)" >/dev/null
}

head_sha() {
  if [ -n "${HEAD_SHA:-}" ]; then
    printf "%s\n" "$HEAD_SHA"
    return
  fi

  require_env GITHUB_REPOSITORY
  require_env PR_NUMBER
  gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" --jq ".head.sha"
}

post_status() {
  require_env GITHUB_REPOSITORY

  local sha="$1"
  local state="$2"
  local description="$3"
  local args
  args=(
    -X POST
    "repos/${GITHUB_REPOSITORY}/statuses/${sha}"
    -f "state=${state}"
    -f "context=${CLA_STATUS_CONTEXT}"
    -f "description=${description}"
  )

  if [ -n "${GITHUB_RUN_ID:-}" ]; then
    args+=(-f "target_url=${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}")
  fi

  gh api "${args[@]}" >/dev/null
}

collect_required_logins() {
  require_env GITHUB_REPOSITORY
  require_env PR_NUMBER

  # Capture each API call separately and return non-zero explicitly on failure.
  # A piped brace group would mask a failed first call (its exit status is the
  # last command), and set -e cannot be relied on here: callers invoke this in
  # an `if` condition, which disables set -e for the whole function body. An
  # explicit return is the only way to fail closed.
  local pr_author commit_authors
  if ! pr_author="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" --jq ".user.login")"; then
    return 1
  fi
  if ! commit_authors="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/commits" --jq ".[].author.login // empty")"; then
    return 1
  fi

  printf "%s\n%s\n" "$pr_author" "$commit_authors" | awk 'NF' | sort -fu
}

collect_unmapped_commit_shas() {
  require_env GITHUB_REPOSITORY
  require_env PR_NUMBER

  gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/commits" \
    --jq '.[] | select(.author == null) | .sha[0:7]'
}

find_status_comment() {
  require_env GITHUB_REPOSITORY
  require_env PR_NUMBER

  # Match only comments authored by the bot identity, so a contributor cannot
  # spoof the marker in their own comment and divert the bot's edits to it.
  # Pipe through real jq (not gh's embedded jq) so the author can be passed as
  # data via --arg rather than interpolated into the filter string.
  gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" --jq '.[]' |
    jq -r --arg author "$CLA_COMMENT_AUTHOR" \
      'select((.user.login // "" | ascii_downcase) == ($author | ascii_downcase))
       | select(.body | contains("<!-- specrider-cla-status -->"))
       | .id' |
    tail -n 1
}

write_comment_payload() {
  local body_file="$1"
  local payload_file="$2"
  jq -Rs '{body: .}' "$body_file" >"$payload_file"
}

upsert_status_comment() {
  if [ "$CLA_PR_COMMENT" != "true" ]; then
    return 0
  fi

  local state="$1"
  local missing_mentions="${2:-}"
  local unmatched_authors="${3:-}"
  local existing_id body_file payload_file
  existing_id="$(find_status_comment || true)"

  if [ "$state" = "success" ] && [ -z "$existing_id" ]; then
    return 0
  fi

  body_file="$(mktemp)"
  payload_file="$(mktemp)"

  if [ "$state" = "success" ]; then
    cat >"$body_file" <<EOF
<!-- specrider-cla-status -->
CLA signatures are complete for this pull request.
EOF
  else
    cat >"$body_file" <<EOF
<!-- specrider-cla-status -->
CLA signatures are required before this pull request can merge.

Missing Individual CLA signatures: ${missing_mentions}

To sign, review [CLA.md](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/blob/main/CLA.md) and comment exactly:

\`${CLA_SIGN_COMMENT}\`

Signer records are stored in a private repository and contain only your GitHub username, the CLA version, the CLA document hash, a timestamp, and this pull request comment URL.

If you are contributing on behalf of an employer, also follow [CCLA.md](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/blob/main/CCLA.md).
EOF

    if [ -n "$unmatched_authors" ]; then
      cat >>"$body_file" <<EOF

The CLA check could not map these commits to GitHub accounts:

\`\`\`
${unmatched_authors}
\`\`\`

Amend those commits with an email address connected to a GitHub account, then push the branch again.
EOF
    fi
  fi

  write_comment_payload "$body_file" "$payload_file"

  if [ -n "$existing_id" ]; then
    gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing_id}" --input "$payload_file" >/dev/null
  else
    gh api -X POST "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" --input "$payload_file" >/dev/null
  fi
}

write_summary() {
  local state="$1"
  local details="$2"

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### CLA"
      echo
      echo "$details"
    } >>"$GITHUB_STEP_SUMMARY"
  fi

  echo "$details"
  if [ "$state" = "failure" ]; then
    echo "::warning::${details}"
  fi
}

check_pr_signatures() {
  ensure_tools
  require_env GH_TOKEN
  require_env GITHUB_REPOSITORY
  require_env PR_NUMBER

  local sha
  sha="$(head_sha)"
  post_status "$sha" "pending" "Checking CLA signatures"

  # Gather PR data into temp files first so an API failure cannot be swallowed
  # by process substitution (which set -e does not catch). On any failure we
  # fail closed: post an error status and abort rather than reporting success.
  local logins_file shas_file
  logins_file="$(mktemp)"
  shas_file="$(mktemp)"

  if ! collect_required_logins >"$logins_file"; then
    rm -f "$logins_file" "$shas_file"
    post_status "$sha" "error" "Could not load pull request authors"
    write_summary "failure" "CLA check could not load pull request authors from the GitHub API."
    return 1
  fi
  if ! collect_unmapped_commit_shas >"$shas_file"; then
    rm -f "$logins_file" "$shas_file"
    post_status "$sha" "error" "Could not load pull request commits"
    write_summary "failure" "CLA check could not load pull request commits from the GitHub API."
    return 1
  fi

  local required_logins=()
  local unmapped_commit_shas=()
  local collected
  while IFS= read -r collected; do
    required_logins+=("$collected")
  done <"$logins_file"
  while IFS= read -r collected; do
    unmapped_commit_shas+=("$collected")
  done <"$shas_file"
  rm -f "$logins_file" "$shas_file"

  local missing=()
  local login
  for login in "${required_logins[@]}"; do
    if is_bypassed "$login"; then
      continue
    fi

    if ! has_signature "$login"; then
      missing+=("$login")
    fi
  done

  local unmatched_text=""
  if [ "${#unmapped_commit_shas[@]}" -gt 0 ]; then
    unmatched_text="$(printf "%s\n" "${unmapped_commit_shas[@]}")"
  fi

  if [ "${#missing[@]}" -gt 0 ] || [ -n "$unmatched_text" ]; then
    local missing_mentions
    if [ "${#missing[@]}" -gt 0 ]; then
      missing_mentions="$(join_mentions "${missing[@]}")"
    else
      missing_mentions="none"
    fi

    local status_description="Missing CLA signature"
    local failure_summary="Missing CLA signature(s): ${missing_mentions}"
    if [ -n "$unmatched_text" ]; then
      local unmatched_inline="${unmatched_text//$'\n'/, }"
      if [ "${#missing[@]}" -eq 0 ]; then
        status_description="Unmapped commit author"
        failure_summary="Could not map commit(s) to GitHub accounts: ${unmatched_inline}"
      else
        failure_summary="${failure_summary}; unmapped commits: ${unmatched_inline}"
      fi
    fi

    post_status "$sha" "failure" "$status_description"
    upsert_status_comment "failure" "$missing_mentions" "$unmatched_text"
    write_summary "failure" "$failure_summary"
    return 0
  fi

  post_status "$sha" "success" "All contributors have signed the CLA"
  upsert_status_comment "success"
  write_summary "success" "All contributors have signed the CLA."
}

record_signature() {
  ensure_tools
  require_env GH_TOKEN
  require_env GITHUB_REPOSITORY
  require_env PR_NUMBER
  require_env COMMENTER
  require_env COMMENT_BODY

  if [ "$COMMENT_BODY" != "$CLA_SIGN_COMMENT" ]; then
    echo "Comment does not match the CLA signing phrase; skipping."
    return 0
  fi

  git -C "$CLA_RECORDS_DIR" config user.name "$CLA_BOT_NAME"
  git -C "$CLA_RECORDS_DIR" config user.email "$CLA_BOT_EMAIL"
  git -C "$CLA_RECORDS_DIR" pull --ff-only origin "$CLA_RECORDS_BRANCH"

  local file
  file="$(signature_file)"
  mkdir -p "$(dirname "$file")"
  if [ ! -f "$file" ]; then
    printf "[]\n" >"$file"
  fi

  jq -e 'type == "array"' "$file" >/dev/null

  local doc_sha signed_at comment_url record tmp
  doc_sha="$(sha256sum "$CLA_DOC_PATH" | awk '{print $1}')"
  signed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  comment_url="${COMMENT_URL:-${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/pull/${PR_NUMBER}}"

  record="$(
    jq -n \
      --arg login "$COMMENTER" \
      --arg version "$CLA_VERSION" \
      --arg doc_path "$CLA_DOC_PATH" \
      --arg doc_sha "$doc_sha" \
      --arg signed_at "$signed_at" \
      --arg repo "$GITHUB_REPOSITORY" \
      --arg pr "$PR_NUMBER" \
      --arg comment_url "$comment_url" \
      '{
        github_login: $login,
        cla_version: $version,
        cla_document_path: $doc_path,
        cla_document_sha256: $doc_sha,
        signed_at: $signed_at,
        source: {
          repo: $repo,
          pull_request: ($pr | tonumber),
          comment_url: $comment_url
        }
      }'
  )"

  tmp="$(mktemp)"
  jq \
    --arg login "$(lower "$COMMENTER")" \
    --arg version "$CLA_VERSION" \
    --argjson record "$record" \
    'if any(.[]; (((.github_login // "") | ascii_downcase) == $login) and ((.cla_version // "") == $version))
     then .
     else . + [$record]
     end
     | sort_by((.github_login // "" | ascii_downcase), (.cla_version // ""), (.signed_at // ""))' \
    "$file" >"$tmp"
  mv "$tmp" "$file"

  git -C "$CLA_RECORDS_DIR" add "$CLA_SIGNATURES_PATH"

  if git -C "$CLA_RECORDS_DIR" diff --cached --quiet; then
    echo "CLA signature for ${COMMENTER} was already recorded."
  else
    git -C "$CLA_RECORDS_DIR" commit -m "Record ${CLA_VERSION} signature for ${COMMENTER}"
    git -C "$CLA_RECORDS_DIR" push origin "HEAD:${CLA_RECORDS_BRANCH}"
    echo "Recorded CLA signature for ${COMMENTER}."
  fi

  check_pr_signatures
}

case "${1:-}" in
  check)
    check_pr_signatures
    ;;
  sign)
    record_signature
    ;;
  *)
    echo "usage: $0 {check|sign}" >&2
    exit 2
    ;;
esac
