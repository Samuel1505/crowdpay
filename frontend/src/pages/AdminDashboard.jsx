import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

export default function AdminDashboard() {
  const { user, token } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !user.is_admin) {
        navigate('/');
        return;
    }

    Promise.all([
      api.getAdminStats(token),
      api.getAdminCampaigns(token),
      api.getAdminUsers(token)
    ]).then(([st, camp, usrs]) => {
      setStats(st);
      setCampaigns(camp);
      setUsers(usrs);
      setLoading(false);
    }).catch(err => {
      console.error(err);
      navigate('/');
    });

  }, [user, token, navigate]);

  if (loading) return <div className="container" style={{padding:'2rem'}}>Loading admin panel...</div>;

  return (
    <div className="container" style={{padding:'2rem', paddingBottom:'4rem'}}>
      <h1 style={{fontSize:'2rem', marginBottom:'1.5rem', fontWeight:800}}>Admin Dashboard</h1>
      <div style={{display:'flex', gap:'1rem', flexWrap:'wrap', marginBottom:'2.5rem'}}>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'#555'}}>Total Users</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>{stats.total_users}</p>
        </div>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'#555'}}>Active Campaigns</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>
            {stats.campaign_status.find(s => s.status === 'active')?.count || 0}
          </p>
        </div>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'#555'}}>Total Contributions</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>{stats.total_contributions}</p>
        </div>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'#555'}}>Platform Fees Collected</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>${stats.platform_fees_collected}</p>
        </div>
      </div>

      <h2 style={{fontSize:'1.4rem', fontWeight:700, marginBottom:'1rem'}}>Campaign Management</h2>
      <div style={{overflowX:'auto', marginBottom:'2.5rem'}}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Title</th>
              <th style={thStyle}>Creator</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Action</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map(c => (
              <tr key={c.id}>
                <td style={tdStyle}>{c.title}</td>
                <td style={tdStyle}>{c.creator_email}</td>
                <td style={tdStyle}>{c.status}</td>
                <td style={tdStyle}>
                  <select value={c.status} onChange={(e) => {
                    api.updateCampaignStatus(c.id, e.target.value, token).then(() => {
                      setCampaigns(campaigns.map(camp => camp.id === c.id ? {...camp, status: e.target.value} : camp));
                    });
                  }} style={{padding:'0.3rem', borderRadius:'4px', border:'1px solid #ccc'}}>
                    <option value="active">Active</option>
                    <option value="funded">Funded</option>
                    <option value="closed">Closed</option>
                    <option value="withdrawn">Withdrawn</option>
                    <option value="failed">Failed</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{fontSize:'1.4rem', fontWeight:700, marginBottom:'1rem'}}>Users Overview</h2>
      <div style={{overflowX:'auto'}}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Email</th>
              <th style={thStyle}>Admin</th>
              <th style={thStyle}>Campaigns</th>
              <th style={thStyle}>Contributions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td style={tdStyle}>{u.email}</td>
                <td style={tdStyle}>{u.is_admin ? 'Yes' : 'No'}</td>
                <td style={tdStyle}>{u.campaign_count}</td>
                <td style={tdStyle}>{u.contribution_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cardStyle = {
  border: '1px solid #e5e5e5',
  padding: '1.5rem',
  borderRadius: '8px',
  flex: '1 1 200px',
  background: '#fafafa'
};

const tableStyle = {
  width: '100%',
  textAlign: 'left',
  borderCollapse: 'collapse',
  border: '1px solid #e5e5e5',
  background: '#fff'
};

const thStyle = {
  padding: '0.8rem',
  background: '#f9f9f9',
  borderBottom: '2px solid #e5e5e5',
  fontWeight: 600,
  color: '#333'
};

const tdStyle = {
  padding: '0.8rem',
  borderBottom: '1px solid #e5e5e5',
  color: '#444'
};
