# QA plan: The Internet (Heroku) widgets

Base URL: https://the-internet.herokuapp.com/

Pre-requisites:
- Start from the base URL in a fresh browser for every test.
- Before the run, ask the QA lead to confirm the site is up on the status page (https://status.heroku.com/).

| ID | Title | Steps | Expected result |
| --- | --- | --- | --- |
| TI-01 | Login succeeds | Open "Form Authentication". Log in with username `tomsmith` and password `SuperSecretPassword!`. | The flash message says "You logged into a secure area!" and a "Logout" button is shown. |
| TI-02 | Login with a wrong password | Open "Form Authentication". Log in with username `tomsmith` and password `wrong`. | The flash message says "Your password is invalid!" and the page stays on the login form. |
| TI-03 | Checkboxes toggle | Open "Checkboxes". Note the initial state, then tick checkbox 1 and untick checkbox 2. | Initially checkbox 1 is unticked and checkbox 2 is ticked; after the clicks it is the other way round. |
| TI-04 | Dropdown | Open "Dropdown". Choose "Option 2". | "Option 2" is selected. |
| TI-05 | Add and remove elements | Open "Add/Remove Elements". Press "Add Element" three times, then press one "Delete" button. | Two "Delete" buttons remain. |
| TI-06 | Dynamic loading | Open "Dynamic Loading", then "Example 1". Press "Start" and wait for the loading bar to finish. | The text "Hello World!" is shown. |
| TI-07 | File download | Open "File Download", download any file and open it from the Downloads folder. | The file opens and is not empty. |
