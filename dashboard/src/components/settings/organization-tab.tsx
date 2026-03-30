'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { fetchOrgMetadata } from '@/lib/actions/settings';

interface OrgData {
  context: {
    name: string;
    description: string;
    industry: string;
    icp: string;
    value_prop: string;
  };
  brandVoice: string;
}

export function OrganizationTab() {
  const [data, setData] = useState<OrgData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const result = await fetchOrgMetadata();
    setData(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div className="h-48 rounded-xl bg-muted/30 animate-pulse" />;
  }

  if (!data || (!data.context.name && !data.brandVoice)) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            Organization not configured. Run{' '}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">/cortextos-setup</code>{' '}
            to set up your Organization.
          </p>
        </CardContent>
      </Card>
    );
  }

  const fields = [
    { label: 'Name', value: data.context.name },
    { label: 'Description', value: data.context.description },
    { label: 'Industry', value: data.context.industry },
    { label: 'Audience / ICP', value: data.context.icp },
    { label: 'Value Proposition', value: data.context.value_prop },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Organization Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {fields.map(({ label, value }) => (
            <div key={label}>
              <Label className="text-xs text-muted-foreground">{label}</Label>
              <p className="text-sm mt-0.5">{value || <span className="text-muted-foreground italic">Not set</span>}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {data.brandVoice && (
        <Card>
          <CardHeader>
            <CardTitle>Brand Voice</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-sm whitespace-pre-wrap font-sans text-muted-foreground">
              {data.brandVoice}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
