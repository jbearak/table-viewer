# Make VS Code comfortable for Table Viewer

You do not need to become a programmer or set up a project to use Table Viewer. VS Code can simply be the app that opens your spreadsheet files.

This page is optional. The default VS Code layout works with Table Viewer, and every change below is reversible. Pick only the changes that make the window feel more comfortable.

## Why I use VS Code

VS Code is a practical common denominator: it was again the most-used developer environment among respondents to the [2025 Stack Overflow Developer Survey](https://survey.stackoverflow.co/2025/technology/), and the same editor works on macOS, Windows, and Linux. I wanted everyone on my team—especially people still learning their way around a code editor—to learn one set of tools, share what they learned, and help one another whether they worked in Stata or R.

The [**Remote - SSH** extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) was equally important. VNC shows you another computer's entire desktop and sends your mouse and keyboard actions back to it. With Remote - SSH, the VS Code window stays on your own computer; your files stay on the remote server, and commands, extensions, and computations run there. It usually feels much more like using a normal local app, while still letting the team keep data and demanding work on a shared or more powerful machine.

VS Code also supports **language servers**: extensions that understand a programming language as you type. They can flag errors, suggest completions, jump to definitions, and follow relationships across files. This extension model is common in modern code editors, but it is not the model used by RStudio or Stata's built-in editor.

My [**Sight**](https://marketplace.visualstudio.com/items?itemName=jbearak.sight) and [**Raven**](https://marketplace.visualstudio.com/items?itemName=jbearak.raven-r) extensions bring that kind of assistance to Stata and R, including cross-file understanding beyond those programs' built-in editing tools. Their data viewers also share some code with Table Viewer, deliberately giving you a similar grid and familiar controls whether you open an Excel file with Table Viewer, inspect a Stata dataset with Sight, or look at an R data frame with Raven.

## The few parts you need

VS Code is normally used with a folder open as a **workspace**. That is why its left side includes tools for browsing a project's files, searching across them, tracking code changes, and running programs.

For Table Viewer, the important parts are much simpler:

- The large **editor area** is where each workbook opens in a tab.
- The **Activity Bar** is a strip of shortcuts along one edge of the VS Code window.
- Selecting an Activity Bar icon opens the **Side Bar**. The file icon opens Explorer, the magnifying glass opens Search, and the blocks icon opens Extensions.

The screenshots in the [setup and try-out guide](setup-guide.md) keep only those three Activity Bar views: Explorer, Search, and Extensions. You may see more icons, and that is completely normal.

## Open a table file without a workspace

You can open one file at a time. There is no need to choose **Open Folder** or create a workspace.

Use whichever route feels most familiar:

- In VS Code, choose **File → Open File…**, select an `.xlsx`, `.xls`, `.csv`, or `.tsv` file, and click **Open**.
- In Finder on macOS or File Explorer on Windows, right-click a supported file and choose **Open With → Visual Studio Code**. The exact wording can vary slightly by operating-system version.
- Drag the file from Finder or File Explorer onto an empty VS Code window.

> [!NOTE]
> `.xlsx`, `.xls`, `.csv`, and `.tsv` files all open directly in Table Viewer by default.
>
> The Excel formats have the richest viewing support: multiple worksheets, merged cells, number and date formatting, and bold or italic text. They are read-only. CSV and TSV files are single unformatted tables that you can edit. You can also reopen them in VS Code's text editor and use Table Viewer's synchronized side-by-side preview.

VS Code remembers open files when you close and reopen it. A file may therefore still be waiting in its tab the next time you start the app.

## Make the window quieter

These are useful starting points, not requirements.

### Keep only the useful Activity Bar icons

Right-click an empty part of the Activity Bar. Leave **Explorer**, **Search**, and **Extensions** checked, and uncheck views such as **Source Control** and **Run and Debug** if you do not plan to use them. You can also drag the remaining icons into a more convenient order.

This hides shortcuts, not the underlying features. Right-click the Activity Bar again and re-check an item whenever you want it back.

### Give the workbook more room

Choose **View → Appearance** to show or hide parts of the window:

- Turn off **Primary Side Bar** when you are viewing a workbook. Select an Activity Bar icon, or use the same menu, to bring it back.
- Turn off **Secondary Side Bar** if VS Code opened a second sidebar for Chat.
- Turn off **Status Bar** if you do not need the narrow information strip along the bottom.

If you rarely use any sidebar, choose **View → Appearance → Activity Bar Position → Top** for a compact horizontal arrangement, or choose **Hidden** to remove the Activity Bar entirely. The same menu restores its default position.

### Disable built-in AI features, if you prefer

Closing Chat or hiding the Secondary Side Bar only removes Chat from view. To turn off VS Code's built-in AI features as well:

1. Select the gear-shaped **Manage** button and choose **Settings**, or press `Cmd+,` on macOS / `Ctrl+,` on Windows and Linux.
2. Search for `disable AI features`.
3. Turn on **Chat: Disable AI Features**.

This hides built-in Chat and inline AI suggestions and disables the GitHub Copilot extensions if they are installed. Return to the same setting and turn it off if you want those features later.

## Match the screenshots' colors, if you like

The light colors in the guide screenshots come from the **Catppuccin Latte** theme. A theme changes VS Code's appearance; it does not change your workbooks.

To use it:

1. Open **Extensions** from the blocks icon in the Activity Bar.
2. Search for `@id:Catppuccin.catppuccin-vsc` and install [**Catppuccin for VSCode**](https://marketplace.visualstudio.com/items?itemName=Catppuccin.catppuccin-vsc), published by **Catppuccin**.
3. Choose **Preferences: Color Theme** from the Command Palette (`Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows and Linux), then select **Catppuccin Latte**.

VS Code also includes several themes out of the box. You can preview them from the same Color Theme picker and use whichever is easiest for you to read. Two other popular choices are:

- [**Solarized Light**](https://github.com/microsoft/vscode/tree/main/extensions/theme-solarized-light) (`vscode.theme-solarized-light`) and [**Solarized Dark**](https://github.com/microsoft/vscode/tree/main/extensions/theme-solarized-dark) (`vscode.theme-solarized-dark`) are built into VS Code, so there is nothing extra to install.
- [**Gruvbox Theme**](https://marketplace.visualstudio.com/items?itemName=jdinhlife.gruvbox) (`jdinhlife.gruvbox`) is a Marketplace extension with light and dark variants at several contrast levels.

## Continue with Table Viewer

Once the window feels comfortable, return to the [setup and 10-minute try-out guide](setup-guide.md) to install Table Viewer and open the sample workbook.

For more detail, VS Code's official documentation explains its [user interface](https://code.visualstudio.com/docs/editing/userinterface), [layout controls](https://code.visualstudio.com/docs/configure/custom-layout), [AI settings](https://code.visualstudio.com/docs/agents/reference/ai-settings), and [color themes](https://code.visualstudio.com/docs/configure/themes).
