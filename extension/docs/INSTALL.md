# Install Handshook

Handshook applies to jobs on Handshake for you. Click **Start** and it clicks Apply,
fills the application form with the documents and saved answers you set up, submits, and
checks the result. You do not need Python, Node.js, a terminal, or an AI key to use it.

**Availability:** the Chrome Web Store listing is not published yet. The GitHub
repository is currently private, and no release is published as of 2026-10-27.
Ask the owner for the release ZIP and checksum, or repository access. The owner
keeps download, store, privacy, and support links in one place:
[distribution links](./STORE.md#distribution-links).

## Before you install

- Use a desktop computer with **current Chrome** (minimum **120**). To check the
  version, enter **`chrome://settings/help`** in the address bar. Edge and Brave
  desktop may load the package, but their side-panel behavior has not been validated
  for this release; use Chrome for this walkthrough. Firefox, Safari, phones, and
  tablets are unsupported. Chrome 120 is the minimum declared by this package.
- Have a Handshake account that you can sign into normally.
- Upload your resume in Handshake first. Upload a cover letter and transcript too
  if the jobs you want require them. Handshook selects existing documents by the ID
  or link you paste; it cannot upload files for you and does not list your documents
  for you.
- Use a normal browser window, in the same browser profile as your Handshake login.
  Do not run the older Python Handshook tool on the account at the same time.

## Option A — Chrome Web Store (coming soon)

**Store link: pending publication** — use the owner-maintained
[Chrome Web Store row](./STORE.md#distribution-links) once it is available.

1. Open the listing from that row. The page should say **Handshook** and identify
   the publisher the owner told you to expect.
2. Click **Add to Chrome**, read the requested permissions, then **Add extension**.
   Handshake access lets Handshook read and fill its pages. OpenRouter access is optional
   and is requested later only if you choose that feature.
3. Click the puzzle-piece **Extensions** icon near the address bar and pin
   **Handshook**. Its icon should now stay in the toolbar.
4. Continue to [First run](#first-run).

## Option B — Release ZIP (no coding needed)

If the owner sent you a ZIP directly, start at step 3. If GitHub shows **404**, the
private repository may not be shared with your account; ask the owner for the ZIP
instead of downloading a look-alike extension elsewhere.

1. Open **GitHub Releases** from the [distribution links](./STORE.md#distribution-links).
   Sign into the GitHub account the owner invited if the repository is still private.
2. Open the release the owner recommends and expand **Assets**. Download
   **`handshook-<version>-chrome.zip`** and its matching **`.zip.sha256`** file.
   Here `<version>` is the release number, for example `1.1.0`. Do not choose
   GitHub's **Source code (zip)** or **Source code (tar.gz)**; those are for developers.
   The checksum identifies the exact file the owner tested. The maintainer's
   [checksum instructions](./RELEASE.md#verify-a-downloaded-package) are optional for friends.
3. Unzip the ZIP: double-click it on macOS, or right-click → **Extract All** on
   Windows. You should get a folder containing **`manifest.json`**, **`sidepanel.html`**,
   and other files. If another folder is inside, open it until you see `manifest.json`.
4. Move that folder somewhere you will keep it, such as Documents → Handshook.
   Do this **before** loading it, and do not delete or move it afterward.
5. Type **`chrome://extensions`** into Chrome's address bar and press Enter.
   You should see a page titled **Extensions**, with cards for installed extensions.
   In Edge use **`edge://extensions`**; in Brave use **`brave://extensions`**.
6. Turn on **Developer mode**. In Chrome the switch is at the top right; in other
   browsers it may be in the side menu. Extra buttons should appear, including
   **Load unpacked**.
7. Click **Load unpacked**. In the folder chooser select the folder containing
   `manifest.json`, then click **Select Folder** or **Open**. Select the folder,
   not the ZIP or the individual manifest file.
8. A **Handshook** card should appear with its version and an enabled switch.
   If Chrome says the manifest is missing, return to step 3 and select the inner folder.
9. Click the puzzle-piece **Extensions** icon beside Chrome's address bar. Find
   **Handshook** and click its pin icon. Close the menu, then click the newly pinned
   Handshook toolbar icon; hovering over it shows **Open Handshook**. The setup
   panel opens beside your tab. Pinning makes the icon easy to find; it does not
   start a run. If the icon is hidden, open the Extensions menu and click Handshook
   there. See the [FAQ](./FAQ.md#the-side-panel-does-not-open) if no panel opens.

Chrome may show a developer-extension reminder for this installation method.
Store installs update through the store; unpacked ZIP installs need manual updates.

Edge uses **`edge://extensions`** and Brave uses **`brave://extensions`**. Their
Developer mode and toolbar visibility controls can be in different places. Chrome's
[load-and-pin instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
and [side-panel documentation](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
describe the Chrome route above. General Chrome-extension compatibility in other
browsers does not establish that Handshook's panel works there.

## First run

1. Open Handshake in a normal tab and log in as you usually do, including any
   school sign-in. Handshook never asks for your Handshake password.
2. Check that the documents you need are uploaded in Handshake's **Documents** area.
3. Click the Handshook toolbar icon. You should see **Handshook setup**, step 1 of 6.
   Click **Continue** on the welcome screen.
4. On **Check your Handshake session**, click **Check session** and wait for
   **Signed in on this browser**. Handshook may open a separate background tab;
   this is its runner tab. Click **Continue**. If it says **Not signed in**, use
   [the login steps](./FAQ.md#handshook-says-i-am-not-logged-in) before starting a run.
5. In the setup **documents** step, click the link to your Handshake documents page
   to open it in a new tab. Open the resume you want, copy its link
   (`https://app.joinhandshake.com/docs/12345678`) or its ID from the address bar,
   paste it into **Default resume**, and give it a name you recognize. Optionally
   paste a **Cover letter**, **Transcript**, or **Other document**, and add up to
   five named additional resumes for automatic matching. Click **Continue**. If you
   have not uploaded a file yet, [add it on Handshake first](./FAQ.md#handshook-cannot-find-or-select-a-document).
6. On **Reusable answers**, enter only accurate answers you want to save, or leave
   them blank. Leave the sensitive-answer auto-submit boxes off while learning.
   Click **Continue**; unanswered job questions will wait in **Needs you**.
7. On **Your saved search**, fill both **Search name** and **Search URL**. Copy the
   address from a Handshake job-search results page, not an individual job or employer
   website. Click **Continue**.
8. On **How should runs behave?**, leave **Autopilot** selected; it is the default and
   applies automatically. Click **Finish setup**. This saves setup; it does not start
   applications.
9. On the dashboard (**Home**), click **Start**. Handshook opens its runner tab and begins
   applying. Watch the first few in **Queue**: a submitted job moves to **Applied** after
   Handshake's confirmation, and anything Handshook will not guess appears in **Needs**.
10. Open **Needs** (the screen heading is **Needs you**) when it shows a count, and supply
    the missing answer or document ID. **Activity** shows the run's events. Use
    **Home → Stop** when you have seen enough; a submission already sent is not undone.
    If you would rather click Submit yourself, switch to **Review** first — see below.

After setup, use **Settings** in the navigation row. Changes to defaults, host,
search, and mode need **Save**. Document IDs, names, and additional resumes are
edited in **Settings → Documents**; the same link to your Handshake documents page is
there when you need another ID. The default resume can be changed by automatic
matching: to always use one resume, turn off **Settings → Documents → Pick a resume
automatically** and **Save**. Always verify the final file selection in the form.

For a one-click **Quick Apply** with no preview form, Handshook clicks the button and
checks the site's confirmation. Check the document the site will use in the submission
record; Quick Apply uses the defaults in your Handshake profile. Watch for the site's
confirmation and the queue's **Applied** status. If the result is uncertain, check
Handshake's application history before trying again.

## Automated runs, Review, and Dry run

- **Autopilot** is the default. It clicks Apply, fills the application dialog (resume
  card, cover letter, transcript or other document, saved answers), clicks **Submit
  Application**, and verifies the result. It submits under your daily cap with pacing.
- **Review** is the opt-out. It prepares each application and leaves submission to you.
  Turn it on when you want to check every form, or while you are still deciding how much
  to automate.
- **Dry run** checks the search and queue without filling or submitting applications.

A job stops for you only when a required question has no saved answer or a required
document has no entered ID; it then waits in **Needs you** with the exact item. Missing
or uncertain information is never guessed. External employer websites require manual
completion.

To change mode or an individual switch, stop the current run, open **Settings → Run mode
and safety**, make the change, and click **Save**. Return to **Home → Start**. Each switch
— review before submitting, one-click Apply, sensitive-answer, EEO and free-text filling —
can be turned off on its own, and **Settings → AI** has separate AI and page-assist
switches. Existing installs are moved to the automated defaults once on update; an
explicit Dry run stays Dry run.

These limits are product controls, not a guarantee of account safety or accurate
applications. Check the first applications it submits and stop at any warning.

The default daily cap for a new installation is **15**, with a maximum setting of **100**.
Updates preserve an existing saved cap. Runs include
delays and breaks and can run at any hour.
If you hit the cap, wait until the next day. Do not reset data to bypass it.

## AI

AI is on by default but needs nothing to work locally: keyword matching chooses among
your resumes on this device. For cloud matching and AI page assist, add your own
OpenRouter key in **Settings → AI**, grant the optional OpenRouter permission, keep or
change the preselected model (`deepseek/deepseek-v4.1-flash`), and test it. OpenRouter
forwards limited job text and resume metadata to the selected model's provider and bills
any usage to you. Page assist sends only control labels and roles, never your answers or
document contents. Provider data collection is denied by default. Follow the
[OpenRouter setup and privacy guidance](./FAQ.md#how-do-i-get-and-add-an-openrouter-key).

## Pause or stop

Use **Home → Pause** for a break and **Resume** when ready. Use **Home → Stop**
to end the run. A submission already sent to Handshake cannot be undone by Stop;
check the site's confirmation/history before retrying an uncertain job. Stop and
seek help if you see a wrong document, unexpected submission, account warning, or CAPTCHA.

## Update later

1. Stop the run. In **Settings → Your data**, export a backup if you want to keep one.
   It contains personal information: keep it private.
2. Download and unzip the next release. Replace the contents of the **same folder**
   you originally loaded, rather than adding a second Handshook installation.
3. On the Extensions page click the reload arrow on Handshook's card. Refresh your
   Handshake tab, reopen the panel, and verify the version and your settings.
4. Start a new run and check the first result. If you switch from an unpacked install to
   a store install, the extension ID and local data may differ. Keep the backup and
   disable the old install so only one copy runs.

For help, reset, or uninstall steps, see [FAQ and troubleshooting](./FAQ.md).

## Remove and add again

Version **1.1.4** includes the fixes for application dialogs that explicitly say
**Applying requires no additional documents** and for verifying files attached under
**Attach other required documents**, plus the honest setup session check, the faster
speed presets, and runs that end on their own when the daily cap is reached. Loading this updated folder after
removal keeps the code fix; it does not depend on settings from the old installation.

Chrome removes extension-local data when you uninstall. Before removal, use
**Settings → Your data → Export private backup** if you want to restore your setup and
history. Keep the backup private. After loading the updated folder, import the backup
from **Settings → Import & export** or complete setup again. Credentials are excluded
from backups, so an optional OpenRouter key must be entered again.

For ordinary updates, replace the files in the same installed folder and use
**Reload**, then refresh the Handshake tab. Check that the extension reports **1.1.4**.
Removing and adding it again is also covered by an isolated browser test that reinstalls
the distributable ZIP twice and verifies the document-free application case.

**Updating from Gemini:** 1.1.0 removes Gemini support and deletes its saved keys.
Old backup settings still import, but do not restore a key. Add an OpenRouter key,
grant its new optional permission, and keep or change the preselected model to restore
cloud matching and page assist. Local keyword matching remains available without these
steps.

## Owner: ways to share with friends

Choose one distribution route and update the single
[distribution-links table](./STORE.md#distribution-links): make this repository public;
keep source private and publish only the policy/support/homepage and release files
from a separate public repository or Pages site; or privately send the ZIP plus
SHA-256 checksum (or invite friends as repository collaborators). Private sharing
supports **Load unpacked**, but does not supply the public URLs needed by the store.
