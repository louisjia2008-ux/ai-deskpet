// @vitest-environment node
import { expect,it,vi } from 'vitest';
import { mcpConnectionTarget } from './mcp-network';

it('pins each HTTPS request to audited public DNS while TLS checks the original hostname',async()=>{
  const publicDns=vi.fn(async()=>[{family:4 as const,address:'93.184.216.34'}]);
  expect(await mcpConnectionTarget('https://mcp.example.org/mcp',publicDns)).toMatchObject({
    hostname:'93.184.216.34',servername:'mcp.example.org',port:443,rejectUnauthorized:true,path:'/mcp',
  });
  expect(publicDns).toHaveBeenCalledExactlyOnceWith('mcp.example.org');
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','64:ff9b::7f00:1','2002:7f00:0001::1','::ffff:7f00:1']){
    await expect(mcpConnectionTarget('https://mcp.example.org/mcp',async()=>[
      {family:4 as const,address:'93.184.216.34'}, {family:address.includes(':')?6:4,address}
    ])).rejects.toThrow();
  }
  const blocked=vi.fn(async()=>[]);
  for (const url of ['https://evil@public.example/mcp','https://127.0.0.1/mcp','https://mcp.example.org:8443/mcp','http://mcp.example.org/mcp','https://mcp.example.org/mcp?k=bad'])
    await expect(mcpConnectionTarget(url,blocked)).rejects.toThrow();
  expect(blocked).not.toHaveBeenCalled();
});
