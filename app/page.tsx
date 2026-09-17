import HistoryAtlas from "./history-atlas";
import { getCurrentYear } from "./demo-data";
export default function Home() { return <HistoryAtlas initialYear={getCurrentYear()} />; }
