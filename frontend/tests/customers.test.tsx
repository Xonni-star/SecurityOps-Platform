/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({
  api:apiMock,
  hasPermission:()=>true,
}));
import {Customers} from '../src/pages/Customers';
import {CustomerDetail} from '../src/pages/CustomerDetail';

const rows=[
  {id:'customer-1',name:'Nordlicht GmbH',email:'kontakt@nordlicht.example',customer_number:'K-100',customer_status:'active',priority:'normal',risk_classification:'low',city:'Hamburg',postal_code:'20095',phone:'040 123456',active_sites:2,active_contracts:1,active_contacts:3,expiring_contracts:0,account_manager_name:'Ava Manager'},
  {id:'customer-2',name:'Hafenwacht AG',email:'office@hafenwacht.example',customer_number:'K-200',customer_status:'at_risk',priority:'high',risk_classification:'high',city:'Bremen',postal_code:'28195',phone:null,active_sites:1,active_contracts:2,active_contacts:1,expiring_contracts:1,account_manager_name:null},
];

beforeEach(()=>{cleanup();apiMock.mockReset();});

describe('customer overview',()=>{
  it('shows backend KPIs and filters the customer table',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/customers')return rows;
      if(path==='/customers/dashboard')return {total:2,active:1,pipeline:0,at_risk:1,archived:0,active_object_links:3,contracts:{total:3,active:2},contracts_expiring_90_days:1};
      return [];
    });
    render(<MemoryRouter initialEntries={['/customers']}><Routes><Route path="/customers" element={<Customers/>}/><Route path="/customers/:customerId" element={<p>Kundenakte</p>}/></Routes></MemoryRouter>);
    expect(await screen.findByText('Hafenwacht AG')).toBeTruthy();
    expect(screen.getByText('Aktive Objektbeziehungen')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Kunde, Nummer/),{target:{value:'Hamburg'}});
    expect(screen.getByText('Nordlicht GmbH')).toBeTruthy();
    await waitFor(()=>expect(screen.queryByText('Hafenwacht AG')).toBeNull());
  });

  it('creates a customer using the customer API and opens its record',async()=>{
    const newCustomer={...rows[0],id:'customer-new',name:'Weser Schutz GmbH'};
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
      if(path==='/customers'&&options?.method==='POST')return newCustomer;
      if(path==='/customers')return rows;
      if(path==='/customers/dashboard')return {total:2,active:1,pipeline:0,at_risk:1,archived:0,active_object_links:3,contracts:{total:3,active:2},contracts_expiring_90_days:1};
      return [];
    });
    render(<MemoryRouter initialEntries={['/customers']}><Routes><Route path="/customers" element={<Customers/>}/><Route path="/customers/:customerId" element={<p>Kundenakte geöffnet</p>}/></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button',{name:/Kunde anlegen/}));
    fireEvent.change(screen.getByLabelText('Unternehmen'),{target:{value:'Weser Schutz GmbH'}});
    fireEvent.click(screen.getAllByRole('button',{name:/Kunde anlegen/})[1]);
    expect(await screen.findByText('Kundenakte geöffnet')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/customers',expect.objectContaining({method:'POST'}));
  });

  it('saves only editable customer fields from the profile form',async()=>{
    const profile={
      customer:{id:'customer-1',name:'Nordlicht GmbH',email:null,customer_number:'K-100',legal_form:null,industry:null,customer_status:'active',priority:'normal',risk_classification:'low',started_on:null,ended_on:null,account_manager_employee_id:null,internal_notes:null,phone:null,website:null,billing_email:null,address_line1:null,address_line2:null,postal_code:null,city:null,region:null,country_code:'DE',billing_address:null,communication_preferences:null,account_manager_name:'Ava Manager'},
      contacts:[],sites:[],contracts:[],documents:[],tasks:[],history:[],operations:{assigned_employees:0,upcoming_shifts:0,open_incidents:0},
    };
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
      if(path==='/customers/customer-1/profile')return profile;
      if(path==='/sites'||path==='/services'||path==='/employees')return [];
      if(path==='/customers/customer-1'&&options?.method==='PATCH')return {};
      return [];
    });
    render(<MemoryRouter initialEntries={['/customers/customer-1/stammdaten']}><Routes><Route path="/customers/:customerId/:section" element={<CustomerDetail/>}/></Routes></MemoryRouter>);
    const name=await screen.findByLabelText('Unternehmen');
    fireEvent.change(name,{target:{value:'Nordlicht Sicherheitsdienst GmbH'}});
    fireEvent.click(screen.getByRole('button',{name:'Stammdaten speichern'}));
    await waitFor(()=>{
      const request=apiMock.mock.calls.find(([path,options])=>path==='/customers/customer-1'&&options?.method==='PATCH');
      expect(request).toBeTruthy();
      const body=JSON.parse(String(request?.[1]?.body));
      expect(body.name).toBe('Nordlicht Sicherheitsdienst GmbH');
      expect(body).not.toHaveProperty('id');
      expect(body).not.toHaveProperty('account_manager_name');
    });
  });
});
