import { openLocalStore, parseSearch, parseThread } from "./store";
import { keys, record } from "./validation";

const main = async (): Promise<void> => {
  const input = record(JSON.parse(await Bun.stdin.text()));
  keys(input, ["method", "input"]);
  const store = openLocalStore();
  try {
    let result: unknown;
    switch (input.method) {
      case "metadata":
        keys(record(input.input), []);
        result = store.metadata();
        break;
      case "freshness":
        keys(record(input.input), []);
        result = store.freshness();
        break;
      case "search":
        result = store.search(parseSearch(input.input));
        break;
      case "thread":
        result = store.thread(parseThread(input.input));
        break;
      default:
        throw new Error("Unknown local read method.");
    }
    process.stdout.write(JSON.stringify(result));
  } finally {
    store.close();
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Local cache read failed.");
  process.exit(1);
});
