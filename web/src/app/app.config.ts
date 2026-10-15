import { ApplicationConfig, LOCALE_ID, provideBrowserGlobalErrorListeners } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeDe from '@angular/common/locales/de';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { authInterceptor } from './auth';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { demoInterceptor, isDemo } from './demo';
import { routes } from './app.routes';

// Zahlen und Prozente im deutschen Format (1.240 · 0,8 · 6 %)
registerLocaleData(localeDe);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Offline-Demo läuft als Datei (file://) – dort funktionieren nur Adressen mit #
    isDemo ? provideRouter(routes, withComponentInputBinding(), withHashLocation()) : provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([demoInterceptor, authInterceptor])),
    { provide: LOCALE_ID, useValue: 'de-DE' },
  ],
};
