# First run

This file is what a new contributor reads on day one. It assumes nothing beyond
a working package manager.

## Install

Install the toolchain, then run the bootstrap target once. It creates the local
database, applies every migration, and loads a small fixture set.

## Verify

Run the check target. A clean run prints a summary and exits zero. Anything else
means the environment is not ready and the output says which step failed.

## Where to go next

Open the router. It explains which context file answers which kind of question.
