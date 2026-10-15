import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { installDemo } from './app/demo';

// Offline-Demo (nur wenn eine Momentaufnahme eingebettet ist)
installDemo();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
