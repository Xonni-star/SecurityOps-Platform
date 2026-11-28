/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';

const auth=vi.hoisted(()=>({
  permissions:new Set<string>(),
  user:{email:'test@example.invalid',role:'viewer',permissions:[] as string[]},
}));

vi.mock('../src/lib/api',()=>({
  hasPermission:(code:string)=>auth.permissions.has(code),
  storedUser:()=>auth.user,
  logout:vi.fn(),
}));

import {Layout} from '../src/components/Layout';

function renderLayout(){
  return render(<MemoryRouter><Layout/></MemoryRouter>);
}

function navLabels():string[]{
  return [...document.querySelectorAll('.nav-item')].map(item=>item.lastChild?.textContent?.trim()??'');
}

describe('rollenabhängige Hauptnavigation',()=>{
  beforeEach(()=>{
    cleanup();
    auth.user={email:'test@example.invalid',role:'viewer',permissions:[]};
    auth.permissions=new Set();
  });

  it('zeigt nur Bereiche mit Leseberechtigung und blendet leere Gruppen aus',()=>{
    auth.user={email:'viewer@example.invalid',role:'viewer',permissions:['nsl:read']};
    auth.permissions=new Set(auth.user.permissions);
    renderLayout();
    expect(navLabels()).toEqual(['Übersicht','Operative Leitstelle']);
    expect(document.querySelectorAll('.nav-label')).toHaveLength(1);
    expect(screen.queryByText('Administration')).toBeNull();
    expect(screen.queryByText('Mitarbeiter')).toBeNull();
  });

  it('verbirgt die Administration für Viewer trotz audit:read',()=>{
    auth.user={email:'viewer@example.invalid',role:'viewer',permissions:['nsl:read','audit:read','employees:read']};
    auth.permissions=new Set(auth.user.permissions);
    renderLayout();
    expect(screen.getByText('Mitarbeiter')).toBeTruthy();
    expect(screen.queryByText('Administration')).toBeNull();
  });

  it('zeigt die Administration Administratoren mit Audit-Zugriff',()=>{
    auth.user={email:'admin@example.invalid',role:'admin',permissions:['nsl:read','audit:read']};
    auth.permissions=new Set(auth.user.permissions);
    renderLayout();
    expect(screen.getByText('Administration')).toBeTruthy();
  });

  it('zeigt einen Schreibbereich nur mit dessen Berechtigung',()=>{
    auth.user={email:'operator@example.invalid',role:'operator',permissions:['alarms:write']};
    auth.permissions=new Set(auth.user.permissions);
    renderLayout();
    expect(screen.getByText('Mobile Einsatz-App')).toBeTruthy();
    expect(screen.queryByText('Alarme')).toBeNull();
  });
});
