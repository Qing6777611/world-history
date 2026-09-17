import HistoryAtlas from "./history-atlas";
import { localToday } from "./demo-data";
export default function Home() { return <HistoryAtlas initialToday={localToday()} />; }
