# DropGames

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.6.

## Quick start

```bash
bun install
bun run convex:dev
bun run dev
```

Open `http://localhost:4200/` after both commands are running.

## Realtime backend (Convex)

This project uses [Convex](https://www.convex.dev/) for multiplayer room sync.

- `bun run dev` starts the Angular app (`http://localhost:4200`)
- `bun run convex:dev` starts the Convex function watcher/pusher
- `bun run dev:full` runs both app + Convex together

The frontend reads the Convex URL from `src/environments/environment.ts`.  
The Convex CLI manages deployment selection in `.env.local` (`CONVEX_DEPLOYMENT`, `CONVEX_URL`).

### Troubleshooting

- **Generated API/types look stale**  
  Run `bun run convex:dev` to regenerate `convex/_generated/*` and push the latest backend changes.

- **Multiplayer is not syncing across devices**  
  Confirm `src/environments/environment.ts` has your cloud `convexUrl` (not a localhost URL).

- **Function changes are not showing up**  
  Make sure the Convex watcher is running (`bun run convex:dev`) while developing.

## Development server

To start a local development server, run:

```bash
bun run dev
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
