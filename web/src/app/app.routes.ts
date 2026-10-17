import { Routes } from '@angular/router';
import { ProjectList } from './project-list';
import { ProjectDetail } from './project-detail';
import { StorageList } from './storage-list';
import { StorageDetail } from './storage-detail';
import { ItemBrowser } from './item-browser';
import { MapPage } from './map';
import { Login } from './login';
import { Profile } from './profile';
import { Admin } from './admin';
import { AdminServer } from './admin-server';
import { AdminMods } from './admin-mods';
import { AdminModpack } from './admin-modpack';
import { ModpackPage } from './modpack';
import { adminGuard, guestGuard, loggedInGuard, memberGuard } from './auth';

export const routes: Routes = [
  { path: 'login', component: Login, canActivate: [guestGuard], title: 'Anmelden · Neo' },
  { path: 'warten', component: Profile, canActivate: [loggedInGuard], title: 'Freischaltung · Neo' },
  { path: 'profil', component: Profile, canActivate: [loggedInGuard], title: 'Profil · Neo' },
  { path: 'admin', component: AdminServer, canActivate: [adminGuard], title: 'Admin · Neo' },
  { path: 'admin/benutzer', component: Admin, canActivate: [adminGuard], title: 'Benutzer · Neo' },
  { path: 'admin/server', redirectTo: 'admin' },
  { path: 'admin/backups', redirectTo: 'admin' },
  { path: 'admin/mods', component: AdminMods, canActivate: [adminGuard], title: 'Servermods · Neo' },
  { path: 'admin/modpack', component: AdminModpack, canActivate: [adminGuard], title: 'Clientmods · Neo' },
  {
    path: '',
    canActivateChild: [memberGuard],
    children: [
      { path: '', component: ProjectList, title: 'Bauprojekte · Neo' },
      { path: 'projekte/:id', component: ProjectDetail, title: 'Materialliste · Neo' },
      { path: 'lager', component: StorageList, title: 'Lager · Neo' },
      { path: 'lager/:id', component: StorageDetail, title: 'Lager · Neo' },
      { path: 'items', component: ItemBrowser, title: 'Items · Neo' },
      { path: 'karte', component: MapPage, title: 'Karte · Neo' },
      { path: 'modpack', component: ModpackPage, title: 'Modpack · Neo' },
    ],
  },
  { path: '**', redirectTo: '' },
];
