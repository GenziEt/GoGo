declare global {
  interface Window { Telegram?: { WebApp?: { initData: string; ready(): void; expand(): void; initDataUnsafe?: { start_param?: string } } } }
}
export {};
